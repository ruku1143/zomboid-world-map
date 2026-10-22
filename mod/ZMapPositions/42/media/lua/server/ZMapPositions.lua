-- ZMapPositions (Build 42, server side): writes living, connected players, the
-- server's safehouses and the in-game time to <Zomboid>/Lua/zmap_players.txt every INTERVAL_MS. Write-only:
-- reads no commands and changes nothing in the game. Players that disconnect or die
-- are simply absent from the next write, as are invisible/ghost-mode admins.
--
-- Build 42 getFileWriter only accepts a small extension whitelist (.txt is fine,
-- .json is rejected and returns nil) and Lua cannot create folders, so the JSON
-- document goes straight into the Lua/ folder with a .txt name.

-- Options: set to false to stop sharing that information with the map. Restart the game
-- server after changing them.
local SHOW_HEALTH = true            -- each player's health bar and % on the map
local SHOW_GAME_TIME = true         -- the in-game date and time in the top bar
local HIDE_INVISIBLE_ADMINS = true  -- leave invisible / ghost-mode admins off the map

local INTERVAL_MS = 2000
local FILE_NAME = "zmap_players.txt"
local lastWrite = 0
local lastError = nil
local lastShError = nil
local lastTimeError = nil

local function nowMs()
    if getTimestampMs then return getTimestampMs() end
    return os.time() * 1000
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

-- Overall health 0-100 (BodyDamage), or "null" if it cannot be read for this player.
local function readHealth(p)
    if not SHOW_HEALTH then return "null" end
    local ok, hp = pcall(function() return p:getBodyDamage():getHealth() end)
    if not ok or type(hp) ~= "number" then return "null" end
    return tostring(math.max(0, math.min(100, math.floor(hp))))
end

local function writePositions()
    local players = getOnlinePlayers()
    local parts = {}
    if players then
        for i = 0, players:size() - 1 do
            local p = players:get(i)
            if p and not p:isDead() and not isHidden(p) then
                table.insert(parts, string.format(
                    '{"name":%s,"x":%d,"y":%d,"z":%d,"hp":%s}',
                    jsonString(p:getUsername()),
                    math.floor(p:getX()), math.floor(p:getY()), math.floor(p:getZ()), readHealth(p)))
            end
        end
    end
    -- A safehouse API problem must not stop player positions from being written.
    local okSh, safehouses = pcall(readSafehouses)
    if not okSh then
        if tostring(safehouses) ~= lastShError then
            lastShError = tostring(safehouses)
            print("[ZMapPositions] safehouses unavailable: " .. lastShError)
        end
        safehouses = {}
    end
    -- Likewise, a clock problem must not stop positions.
    local okT, gameTime = pcall(readGameTime)
    if not okT then
        if tostring(gameTime) ~= lastTimeError then
            lastTimeError = tostring(gameTime)
            print("[ZMapPositions] game time unavailable: " .. lastTimeError)
        end
        gameTime = "null"
    end
    local writer = getFileWriter(FILE_NAME, true, false)
    if not writer then error("getFileWriter returned nil for " .. FILE_NAME) end
    writer:write(string.format('{"t":%d,"time":%s,"players":[%s],"safehouses":[%s]}',
        math.floor(nowMs() / 1000), gameTime, table.concat(parts, ","), table.concat(safehouses, ",")))
    writer:close()
end

local function onTick()
    local now = nowMs()
    if now - lastWrite < INTERVAL_MS then return end
    lastWrite = now
    local ok, err = pcall(writePositions)
    if not ok and tostring(err) ~= lastError then
        lastError = tostring(err)
        print("[ZMapPositions] write failed: " .. lastError)
    end
end

-- OnTickEvenPaused keeps writing when PauseEmpty has frozen the world (nobody online).
if Events.OnTickEvenPaused and Events.OnTickEvenPaused.Add then
    Events.OnTickEvenPaused.Add(onTick)
else
    Events.OnTick.Add(onTick)
end

print("[ZMapPositions] loaded, writing Lua/" .. FILE_NAME .. " every " .. INTERVAL_MS .. " ms")
