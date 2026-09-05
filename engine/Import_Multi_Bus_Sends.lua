-- ReaScript (Lua): Map stem_activity_log.csv probs onto Sends 1-5 of the selected track.
-- Create five sends first (acoustic, voice, electric, beats, bass).

local csv_path = "C:/staging_slices/001 - ANiMAL - Clinic A/stem_activity_log.csv"
local filter_suffix = "_bass_locked.wav"
local ramp_sec = 0.05

local track = reaper.GetSelectedTrack(0, 0)
if not track then
  return reaper.ShowMessageBox("Select a source track first.", "Error", 0)
end

local buses = {"prob_acoustic", "prob_voice", "prob_electric", "prob_beats", "prob_bass"}
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

local data = {}
for line in file:lines() do
  local fields = {}
  for val in string.gmatch(line, "([^,]+)") do
    table.insert(fields, val)
  end
  local fname = fields[cols["file"] or 5] or ""
  if filter_suffix == "" or string.find(string.lower(fname), filter_suffix, 1, true) then
    table.insert(data, fields)
  end
end
file:close()

reaper.Undo_BeginBlock()
for send_idx, bus_col in ipairs(buses) do
  local env = reaper.GetTrackEnvelopeByName(track, "Send " .. send_idx .. " Volume")
  if env then
    reaper.DeleteEnvelopePointRange(env, 0, 60 * 60 * 24)
    local last_gain = nil
    for _, row in ipairs(data) do
      local t_start = tonumber(row[cols["start_time_sec"] or 2]) or 0
      local silent_raw = row[cols["is_silent"] or 6] or ""
      local is_silent = silent_raw:match("[Tt]rue")
      local col = cols[bus_col] or (9 + send_idx)
      local gain = is_silent and 0.0 or (tonumber(row[col]) or 0.0)
      if last_gain and math.abs(gain - last_gain) > 1e-6 then
        reaper.InsertEnvelopePoint(env, math.max(0, t_start - ramp_sec), last_gain, 0, 0, false, true)
      end
      reaper.InsertEnvelopePoint(env, t_start, gain, 0, 0, false, true)
      last_gain = gain
    end
    reaper.Envelope_SortPoints(env)
  end
end
reaper.TrackList_AdjustWindows(false)
reaper.Undo_EndBlock("Import Multi-Bus Send Envelopes", -1)
