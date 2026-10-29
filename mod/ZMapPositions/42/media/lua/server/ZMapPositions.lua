-- ZMapPositions (Build 42, server side): writes living, connected players, the
-- server's safehouses and the in-game time to <Zomboid>/Lua/zmap_players.txt every INTERVAL_MS. Write-only:
-- reads no commands and changes nothing in the game. Players that disconnect are simply
-- absent from the next write, as are invisible/ghost-mode admins. Players that die are
-- listed under "dead" (where they died) until the same username is alive again.
--
-- Build 42 getFileWriter only accepts a small extension whitelist (.txt is fine,
-- .json is rejected and returns nil) and Lua cannot create folders, so the JSON
-- document goes straight into the Lua/ folder with a .txt name.

-- Options: set to false to stop sharing that information with the map. Restart the game
-- server after changing them.
local SHOW_HEALTH = true            -- each player's health bar and % on the map
local SHOW_GAME_TIME = true         -- the in-game date and time in the top bar
local SHOW_IN_VEHICLE = true        -- a car icon next to players who are driving or riding
local HIDE_INVISIBLE_ADMINS = true  -- leave invisible / ghost-mode admins off the map
local SHOW_DEATHS = true            -- keep a greyed-out marker where a player died, until they respawn

local INTERVAL_MS = 1000
local FILE_NAME = "zmap_players.txt"
local lastWrite = 0
local lastAge = nil -- world age (hours) at the previous write, to tell whether time is advancing
local lastErrors = {} -- label -> last message printed, so a repeating error is logged once
local lastSeen = {} -- username -> {x, y, z} of the last living write, for deaths we only notice afterwards
local dead = {}     -- username -> {x, y, z} where they died; cleared when they are alive again

local function nowMs()
    if getTimestampMs then return getTimestampMs() end
    return os.time() * 1000
end

-- Runs fn and returns its result, or fallback if it throws (logging each new error once).
-- Keeps one broken game API from stopping the rest of the write.
local function guarded(label, fallback, fn)
    local ok, result = pcall(fn)
    if ok then return result end
    local msg = tostring(result)
    if msg ~= lastErrors[label] then
        lastErrors[label] = msg
        print("[ZMapPositions] " .. label .. ": " .. msg)
    end
    return fallback
end

local function jsonString(s)
    s = tostring(s or "")
    s = s:gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("[%c]", " ")
    return '"' .. s .. '"'
end

-- Safehouses are a server-side list, so unlike world squares they do not need a player nearby.
local function readSafehouses()
    local out = {}
    if not (SafeHouse and SafeHouse.getSafehouseList) then return out end
    local list = SafeHouse.getSafehouseList()
    if not list then return out end
    for i = 0, list:size() - 1 do
        local sh = list:get(i)
        if sh then
            local members = {}
            local names = sh:getPlayers()
            if names then
                for j = 0, names:size() - 1 do table.insert(members, jsonString(names:get(j))) end
            end
            table.insert(out, string.format(
                '{"owner":%s,"title":%s,"x":%d,"y":%d,"w":%d,"h":%d,"members":[%s]}',
                jsonString(sh:getOwner()), jsonString(sh:getTitle()),
                math.floor(sh:getX()), math.floor(sh:getY()), math.floor(sh:getW()), math.floor(sh:getH()),
                table.concat(members, ",")))
        end
    end
    return out
end

-- Admins using /invisible (or ghost mode) must not show up on the map. Each check is
-- guarded because not every build exposes both methods.
local function isHidden(p)
    if not HIDE_INVISIBLE_ADMINS then return false end
    if p.isInvisible and p:isInvisible() then return true end
    if p.isGhostMode and p:isGhostMode() then return true end
    return false
end

-- In-game date and time as JSON (month and day 1-based), or "null" if the clock is unavailable.
local function readGameTime()
    if not SHOW_GAME_TIME then return "null" end
    local gt = getGameTime and getGameTime()
    if not gt then return "null" end
    local day = gt.getDayPlusOne and gt:getDayPlusOne() or (gt:getDay() + 1)
    return string.format('{"y":%d,"mo":%d,"d":%d,"h":%d,"mi":%d}',
        gt:getYear(), gt:getMonth() + 1, day, gt:getHour(), gt:getMinutes())
end

-- "true" / "false" for whether the player is in a vehicle, or "null" if not shared or unreadable.
local function readInVehicle(p)
    if not SHOW_IN_VEHICLE then return "null" end
    local ok, v = pcall(function() return p:getVehicle() end)
    if not ok then return "null" end
    return v and "true" or "false"
end

-- Overall health 0-100 (BodyDamage), or "null" if it cannot be read for this player.
local function readHealth(p)
    if not SHOW_HEALTH then return "null" end
    local ok, hp = pcall(function() return p:getBodyDamage():getHealth() end)
    if not ok or type(hp) ~= "number" then return "null" end
    return tostring(math.max(0, math.min(100, math.floor(hp))))
end

local function deadJson(name, pos)
    return string.format('{"name":%s,"x":%d,"y":%d,"z":%d}', jsonString(name), pos.x, pos.y, pos.z)
end

-- Remembers where a player died. Position comes from the player if readable, else the last living write.
local function markDead(p)
    if not SHOW_DEATHS or not p or isHidden(p) then return end
    local name = p:getUsername()
    if not name or dead[name] then return end
    local ok, pos = pcall(function()
        return { x = math.floor(p:getX()), y = math.floor(p:getY()), z = math.floor(p:getZ()) }
    end)
    dead[name] = (ok and pos) or lastSeen[name]
end

-- One player as JSON, or nil if they are dead, hidden or absent.
local function playerJson(p)
    if not p then return nil end
    if p:isDead() then
        markDead(p)
        return nil
    end
    if isHidden(p) then return nil end
    local name = p:getUsername()
    -- Alive again (a new character): the old death marker goes.
    dead[name] = nil
    lastSeen[name] = { x = math.floor(p:getX()), y = math.floor(p:getY()), z = math.floor(p:getZ()) }
    return string.format('{"name":%s,"x":%d,"y":%d,"z":%d,"hp":%s,"car":%s}',
        jsonString(p:getUsername()),
        math.floor(p:getX()), math.floor(p:getY()), math.floor(p:getZ()), readHealth(p), readInVehicle(p))
end

-- "true" when PauseEmpty has frozen the world (nobody online, setting on, world age not advancing),
-- "false" when the world runs, "null" when it cannot be told. Always updates lastAge.
local function readPaused(onlineCount)
    local okAge, age = pcall(function() return getGameTime():getWorldAgeHours() end)
    local prev = lastAge
    lastAge = okAge and type(age) == "number" and age or nil
    if onlineCount > 0 then return "false" end
    local okOpt, pauseEmpty = pcall(function() return getServerOptions():getOption("PauseEmpty") end)
    if not okOpt or pauseEmpty == nil then return "null" end
    if tostring(pauseEmpty) ~= "true" then return "false" end
    if not lastAge or not prev then return "null" end
    return lastAge == prev and "true" or "false"
end

local function writePositions()
    local players = getOnlinePlayers()
    local parts = {}
    if players then
        for i = 0, players:size() - 1 do
            -- One player who can't be read (e.g. still connecting) must not hide everyone else.
            local p = players:get(i)
            local entry = guarded("player skipped", nil, function() return playerJson(p) end)
            if entry then table.insert(parts, entry) end
        end
    end
    -- Neither a safehouse nor a clock problem may stop player positions from being written.
    local paused = guarded("paused unavailable", "null", function() return readPaused(players and players:size() or 0) end)
    local deadParts = {}
    for name, pos in pairs(dead) do
        if pos then table.insert(deadParts, deadJson(name, pos)) end
    end
    local safehouses = guarded("safehouses unavailable", {}, readSafehouses)
    local gameTime = guarded("game time unavailable", "null", readGameTime)
    local writer = getFileWriter(FILE_NAME, true, false)
    if not writer then error("getFileWriter returned nil for " .. FILE_NAME) end
    writer:write(string.format('{"t":%d,"time":%s,"paused":%s,"players":[%s],"dead":[%s],"safehouses":[%s]}',
        math.floor(nowMs() / 1000), gameTime, paused, table.concat(parts, ","), table.concat(deadParts, ","), table.concat(safehouses, ",")))
    writer:close()
end

local function onTick()
    local now = nowMs()
    if now - lastWrite < INTERVAL_MS then return end
    lastWrite = now
    guarded("write failed", nil, writePositions)
end

-- A player can leave the online list the moment they die, before a write sees isDead(). The
-- death event catches that case. Not every build fires it on the server; the isDead() check
-- in playerJson is the fallback.
if Events.OnPlayerDeath and Events.OnPlayerDeath.Add then
    Events.OnPlayerDeath.Add(function(p) guarded("death event", nil, function() markDead(p) end) end)
end

-- OnTickEvenPaused keeps writing when PauseEmpty has frozen the world (nobody online).
if Events.OnTickEvenPaused and Events.OnTickEvenPaused.Add then
    Events.OnTickEvenPaused.Add(onTick)
else
    Events.OnTick.Add(onTick)
end

print("[ZMapPositions] loaded, writing Lua/" .. FILE_NAME .. " every " .. INTERVAL_MS .. " ms")
