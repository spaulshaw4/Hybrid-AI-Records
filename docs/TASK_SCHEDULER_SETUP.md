# Hybrid 1.0 - Windows Task Scheduler Setup

Automate the nightly audio slicing and Supabase transfer engine using Windows Task Scheduler.

---

## Prerequisites

- `run_hybrid_engine.bat` located at `D:\MusicDatasets\scripts\`
- Supabase credentials configured in the batch file
- Administrator privileges on the Windows machine

---

## Step-by-Step Configuration

### 1. Open Windows Task Scheduler

Press `Win + R`, type `taskschd.msc`, and hit Enter.

Alternatively: Press the Windows Key, type **Task Scheduler**, and hit Enter.

### 2. Create a New Task

On the right-hand panel under the **Actions** menu, click **Create Task...** 

> **Important:** Do not choose "Basic Task" — you need the full task options for administrative privileges.

### 3. Configure General Settings

| Setting | Value |
|---------|-------|
| **Name** | `Hybrid_Engine_Nightly_Transfer` |
| **Description** | Automated 2-phase audio slicer and Supabase cloud transfer |
| **Security Options** | Select **Run whether user is logged on or not** |
| **Privileges** | Check **Run with highest privileges** |

> Running with highest privileges prevents folder permission blocks on the D: drive.

### 4. Set the Trigger Schedule

1. Navigate to the **Triggers** tab
2. Click **New...**
3. Configure:

| Setting | Value |
|---------|-------|
| **Begin the task** | On a schedule |
| **Settings** | Daily |
| **Start time** | `2:00 AM` (or when network traffic is lowest) |
| **Enabled** | ✓ Checked |

4. Click **OK**

### 5. Link the Batch Action

1. Navigate to the **Actions** tab
2. Click **New...**
3. Configure:

| Setting | Value |
|---------|-------|
| **Action** | Start a program |
| **Program/script** | `D:\MusicDatasets\scripts\run_hybrid_engine.bat` |
| **Start in (optional)** | `D:\MusicDatasets\scripts\` |

4. Click **OK**

### 6. Save and Authorize

1. Click **OK** on the main task window
2. Windows will prompt for your administrator password
3. Enter credentials to authorize the background task

---

## Verification

After saving, verify the task appears in the **Task Scheduler Library**.

To manually test:
1. Right-click the task
2. Select **Run**
3. Check `D:\MusicDatasets\logs\` for the generated log file

---

## Log Files

Engine output is logged to:
```
D:\MusicDatasets\logs\engine_run_YYYYMMDD.log
```

Each nightly run appends to a date-stamped log file for audit trails.
