# Hybrid 1.0 — Windows Service Setup

## 1. Create Startup Batch Runner

The launcher script `start_daemon.bat` initializes the Python virtual environment and runs the daemon:

```bat
@echo off
cd /d D:\MusicDatasets
call venv\Scripts\activate
python scripts\worker_daemon.py
pause
```

Location: `D:\MusicDatasets\scripts\start_daemon.bat`

---

## 2. Register as Windows Service with NSSM

To ensure the worker daemon runs persistently (even across reboots and logouts), use **NSSM (Non-Sucking Service Manager)**.

### Download NSSM

1. Download from [nssm.cc](https://nssm.cc/)
2. Place `nssm.exe` in a utility folder (e.g., `C:\tools\`)

### Install the Service

Open **Command Prompt as Administrator** and run:

```cmd
C:\tools\nssm.exe install HybridWorkerDaemon
```

### Configure the Service GUI

A configuration window will appear. Set:

| Field | Value |
|-------|-------|
| **Path** | `C:\Windows\System32\cmd.exe` |
| **Startup directory** | `D:\MusicDatasets` |
| **Arguments** | `/c call venv\Scripts\activate && python scripts\worker_daemon.py` |

Click **"Install service"**.

---

## 3. Verify Service Operation

### Start the Service

```cmd
net start HybridWorkerDaemon
```

### Stop the Service

```cmd
net stop HybridWorkerDaemon
```

### Check Service Status

```cmd
sc query HybridWorkerDaemon
```

---

## 4. Configure Automatic Recovery

1. Open **Services** (`services.msc`)
2. Locate **HybridWorkerDaemon**
3. Right-click → **Properties** → **Recovery** tab
4. Set all failure actions to **"Restart the Service"**:
   - First failure: Restart the Service
   - Second failure: Restart the Service
   - Subsequent failures: Restart the Service

---

## 5. Monitor Logs

If output logging is configured in the daemon, check:

```
D:\MusicDatasets\logs\
```

To verify the daemon is actively polling the payload directory and executing jobs.

---

## Service Management Commands

```cmd
# Install
C:\tools\nssm.exe install HybridWorkerDaemon

# Start
net start HybridWorkerDaemon

# Stop
net stop HybridWorkerDaemon

# Remove
C:\tools\nssm.exe remove HybridWorkerDaemon confirm

# Edit configuration
C:\tools\nssm.exe edit HybridWorkerDaemon
```
