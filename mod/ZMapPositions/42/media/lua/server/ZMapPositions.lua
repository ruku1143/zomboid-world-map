-- ZMapPositions (Build 42, server side): writes living, connected players and the
-- server's safehouses to <Zomboid>/Lua/zmap_players.txt every INTERVAL_MS. Write-only:
-- reads no commands and changes nothing in the game. Players that disconnect or die
-- are simply absent from the next write.
--
-- Build 42 getFileWriter only accepts a small extension whitelist (.txt is fine,
-- .json is rejected and returns nil) and Lua cannot create folders, so the JSON
-- document goes straight into the Lua/ folder with a .txt name.

local INTERVAL_MS = 2000
local FILE_NAME = "zmap_players.txt"
local lastWrite = 0
local lastError = nil
local lastShError = nil

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

local function writePositions()
    local players = getOnlinePlayers()
    local parts = {}
    if players then
        for i = 0, players:size() - 1 do
            local p = players:get(i)
            if p and not p:isDead() then
                table.insert(parts, string.format(
                    '{"name":%s,"x":%d,"y":%d,"z":%d}',
                    jsonString(p:getUsername()),
                    math.floor(p:getX()), math.floor(p:getY()), math.floor(p:getZ())))
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
    local writer = getFileWriter(FILE_NAME, true, false)
    if not writer then error("getFileWriter returned nil for " .. FILE_NAME) end
    writer:write(string.format('{"t":%d,"players":[%s],"safehouses":[%s]}',
        math.floor(nowMs() / 1000), table.concat(parts, ","), table.concat(safehouses, ",")))
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
