-- ZMapPositions: writes living, connected players to <Zomboid>/Lua/zmap_players.json
-- every INTERVAL_MS. Write-only: reads nothing, accepts no commands.
-- Players that disconnect or die are simply absent from the next write.

local INTERVAL_MS = 2000
local FILE_NAME = "zmap_players.json"
local lastWrite = 0

local function jsonString(s)
    s = tostring(s or "")
    s = s:gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("[%c]", " ")
    return '"' .. s .. '"'
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
    local writer = getFileWriter(FILE_NAME, true, false)
    if not writer then return end
    writer:write(string.format('{"t":%d,"players":[%s]}', getTimestamp(), table.concat(parts, ",")))
    writer:close()
end

local function onTick()
    local now = getTimestampMs()
    if now - lastWrite < INTERVAL_MS then return end
    lastWrite = now
    pcall(writePositions)
end

Events.OnTick.Add(onTick)
