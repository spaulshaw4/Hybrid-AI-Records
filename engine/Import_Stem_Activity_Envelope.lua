-- ReaScript (Lua): Import stem_activity_log.csv onto the selected track Volume envelope.
-- Copy this file into your Reaper Scripts directory, or run via Actions > Load ReaScript.

local csv_path = "C:/staging_slices/001 - ANiMAL - Clinic A/stem_activity_log.csv"
local ramp_sec = 0.05
local target_bus = "bass" -- set nil for binary RMS gate: local target_bus = nil

local track = reaper.GetSelectedTrack(0, 0)
if not track then
  return reaper.ShowMessageBox("Select a track first.", "Error", 0)
end

local env = reaper.GetTrackEnvelopeByName(track, "Volume")
if not env then
  reaper.Main_OnCommand(40052, 0) -- Toggle volume envelope visible
  env = reaper.GetTrackEnvelopeByName(track, "Volume")
end
if not env then
  return reaper.ShowMessageBox("Could not get Volume envelope.", "Error", 0)
end

local file = io.open(csv_path, "r")
if not file then
  return reaper.ShowMessageBox("CSV not found:\n" .. csv_path, "Error", 0)
end

local header = file:read("*l") or ""
local cols = {}
local idx = 1
for match in string.gmatch(header, "([^,]+)") do
  cols[match] = idx
  idx = idx + 1
end

local function parse_line(line)
  local fields = {}
  for match in string.gmatch(line, "([^,]+)") do
    table.insert(fields, match)
  end
  return fields
end

reaper.Undo_BeginBlock()
reaper.DeleteEnvelopePointRange(env, 0, 60 * 60 * 24)

local last_gain = nil
for line in file:lines() do
  local fields = parse_line(line)
  local fname = fields[cols["file"] or 5] or ""
  if target_bus and not string.find(string.lower(fname), "_" .. target_bus .. "_locked%.wav") then
    goto continue
  end

  local t_start = tonumber(fields[cols["start_time_sec"] or 2]) or 0
  local silent_raw = fields[cols["is_silent"] or 6] or ""
  local is_silent = silent_raw:match("[Tt]rue")
  local gain
  if is_silent then
    gain = 0.0
  elseif target_bus then
    local col = cols["prob_" .. target_bus]
    gain = tonumber(fields[col or 14]) or 0.0
  else
    gain = 1.0
  end

  if last_gain and math.abs(gain - last_gain) > 1e-6 then
    reaper.InsertEnvelopePoint(env, math.max(0, t_start - ramp_sec), last_gain, 0, 0, false, true)
  end
  reaper.InsertEnvelopePoint(env, t_start, gain, 0, 0, false, true)
  last_gain = gain
  ::continue::
end
file:close()
reaper.Envelope_SortPoints(env)
reaper.TrackList_AdjustWindows(false)
reaper.Undo_EndBlock("Import Stem Activity Volume Envelope", -1)
