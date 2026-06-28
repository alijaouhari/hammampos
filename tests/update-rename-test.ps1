# =============================================================================
# HammamPOS Update Rename Failure Analysis
# =============================================================================
# This script simulates the exact production update scenario:
# 1. Launches HammamPOS.exe from a test directory (with CWD set to that dir)
# 2. Waits for it to fully start
# 3. Kills it (exactly as the updater PS1 does)
# 4. Attempts to rename the directory every 250ms
# 5. Logs every failure with the exact Windows error
# 6. Records what processes/handles are blocking
#
# Run as Administrator from the project root.
# =============================================================================

$ErrorActionPreference = 'Continue'

# --- Configuration ---
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceDir = Join-Path $projectRoot "dist\win-unpacked"
$testDir = "C:\HammamPOS-RenameTest"
$testOldDir = "C:\HammamPOS-RenameTest-old"
$logFile = Join-Path $projectRoot "tests\rename-test-results.log"
$iterations = 20

# --- Verify prerequisites ---
if (-not (Test-Path $sourceDir)) {
    Write-Host "ERROR: dist\win-unpacked not found. Run 'npx electron-builder --win --dir' first." -ForegroundColor Red
    exit 1
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: Must run as Administrator." -ForegroundColor Red
    exit 1
}

# --- Initialize log ---
$logContent = @()
$logContent += "=" * 80
$logContent += "HammamPOS Rename Failure Analysis"
$logContent += "Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$logContent += "Machine: $env:COMPUTERNAME"
$logContent += "OS: $((Get-CimInstance Win32_OperatingSystem).Caption)"
$logContent += "Iterations: $iterations"
$logContent += "=" * 80
$logContent += ""

Write-Host "HammamPOS Rename Failure Analysis" -ForegroundColor Cyan
Write-Host "Running $iterations iterations..." -ForegroundColor Cyan
Write-Host ""

# --- Helper: Get all processes with handles in a directory ---
function Get-DirectoryHandles($dir) {
    # Use handle.exe if available, otherwise fall back to process inspection
    $results = @()
    
    # Method 1: Check all running processes for the directory name
    $allProcs = Get-Process -ErrorAction SilentlyContinue
    foreach ($proc in $allProcs) {
        try {
            # Check if process path is inside our test dir
            if ($proc.Path -and $proc.Path.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase)) {
                $results += "$($proc.ProcessName) (PID $($proc.Id)) - exe inside dir"
            }
            # Check if process CWD might be our dir (only works for current user processes)
        } catch {}
    }
    
    # Method 2: Check for cmd.exe/powershell with our dir as possible CWD
    Get-WmiObject Win32_Process -Filter "Name='cmd.exe' OR Name='powershell.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.CommandLine -match [regex]::Escape($dir)) {
            $results += "$($_.Name) (PID $($_.ProcessId)) - command line references dir"
        }
    }
    
    return $results
}

# --- Helper: Check Windows Defender activity ---
function Get-DefenderActivity($dir) {
    try {
        $defender = Get-Process -Name "MsMpEng" -ErrorAction SilentlyContinue
        if ($defender) {
            return "Windows Defender running (PID $($defender.Id), CPU: $($defender.CPU)s)"
        }
        return "Windows Defender not detected"
    } catch {
        return "Could not check Defender: $_"
    }
}

# --- Helper: Check Explorer locks ---
function Get-ExplorerLocks($dir) {
    $explorer = Get-Process -Name "explorer" -ErrorAction SilentlyContinue
    if ($explorer) {
        # We can't easily determine if Explorer has the folder open without handle.exe
        return "Explorer running (PID $($explorer.Id)) - cannot determine folder lock without Sysinternals handle.exe"
    }
    return "Explorer not running"
}

# --- Main test loop ---
$allResults = @()

for ($i = 1; $i -le $iterations; $i++) {
    Write-Host "--- Iteration $i / $iterations ---" -ForegroundColor Yellow
    $iterLog = @()
    $iterLog += "--- Iteration $i / $iterations ---"
    
    # --- Setup: Copy built app to test directory ---
    if (Test-Path $testDir) { Remove-Item -Path $testDir -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }
    if (Test-Path $testOldDir) { Remove-Item -Path $testOldDir -Recurse -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }
    
    Copy-Item -Path $sourceDir -Destination $testDir -Recurse -Force
    
    # --- Launch HammamPOS.exe with CWD set to test dir (simulates desktop shortcut) ---
    $iterLog += "Launching HammamPOS.exe with CWD=$testDir"
    $proc = Start-Process -FilePath (Join-Path $testDir "HammamPOS.exe") -WorkingDirectory $testDir -PassThru
    $mainPid = $proc.Id
    $iterLog += "Main process PID: $mainPid"
    
    # Wait for app to fully start (Electron spawns child processes)
    Start-Sleep -Seconds 5
    
    # Record all HammamPOS processes
    $hamProcs = Get-Process -Name "HammamPOS" -ErrorAction SilentlyContinue
    $iterLog += "HammamPOS processes after launch: $($hamProcs.Count)"
    foreach ($hp in $hamProcs) {
        $iterLog += "  PID $($hp.Id) - WorkingSet: $([math]::Round($hp.WorkingSet64/1MB, 1))MB"
    }
    
    # Record process.cwd() equivalent (the main process working directory)
    try {
        $wmiProc = Get-WmiObject Win32_Process -Filter "ProcessId=$mainPid" -ErrorAction SilentlyContinue
        if ($wmiProc) {
            $iterLog += "Main process CommandLine: $($wmiProc.CommandLine)"
            $iterLog += "Main process ExecutablePath: $($wmiProc.ExecutablePath)"
        }
    } catch {}
    
    # --- Kill all HammamPOS processes (exactly as the updater does) ---
    $killTime = Get-Date
    Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
    
    $iterLog += "Killed all processes at: $($killTime.ToString('HH:mm:ss.fff'))"
    
    # --- Attempt rename every 250ms, log each failure ---
    $renameStart = Get-Date
    $attempt = 0
    $maxAttempts = 120  # 30 seconds max (120 * 250ms)
    $renamed = $false
    $failureReasons = @()
    
    while (-not $renamed -and $attempt -lt $maxAttempts) {
        $attempt++
        $attemptTime = (Get-Date) - $renameStart
        
        try {
            Rename-Item -Path $testDir -NewName "HammamPOS-RenameTest-old" -Force -ErrorAction Stop
            $renamed = $true
            $renameSuccessTime = $attemptTime.TotalMilliseconds
        } catch {
            $errMsg = $_.Exception.Message
            $failureReasons += "Attempt $attempt (${attemptTime}ms): $errMsg"
            
            # Every 4 attempts (every 1 second), log what's blocking
            if ($attempt % 4 -eq 0) {
                $remaining = Get-Process -Name "HammamPOS" -ErrorAction SilentlyContinue
                $handles = Get-DirectoryHandles $testDir
                $defender = Get-DefenderActivity $testDir
                
                $failureReasons += "  >> Remaining HammamPOS procs: $($remaining.Count)"
                if ($remaining) {
                    foreach ($r in $remaining) {
                        $failureReasons += "     PID $($r.Id) HasExited=$($r.HasExited)"
                    }
                }
                $failureReasons += "  >> Directory handles: $($handles -join '; ')"
                $failureReasons += "  >> Defender: $defender"
                
                # Try killing again
                Stop-Process -Name "HammamPOS" -Force -ErrorAction SilentlyContinue
            }
            
            Start-Sleep -Milliseconds 250
        }
    }
    
    # --- Record results ---
    $result = @{
        Iteration = $i
        ProcessCount = $hamProcs.Count
        Renamed = $renamed
        Attempts = $attempt
        TimeMs = if ($renamed) { [math]::Round($renameSuccessTime, 0) } else { "FAILED" }
        FirstError = if ($failureReasons.Count -gt 0) { $failureReasons[0] } else { "none" }
    }
    $allResults += $result
    
    if ($renamed) {
        $iterLog += "RENAME SUCCEEDED after $attempt attempts ($([math]::Round($renameSuccessTime, 0))ms after kill)"
        Write-Host "  PASS: Renamed after $attempt attempts ($([math]::Round($renameSuccessTime, 0))ms)" -ForegroundColor Green
    } else {
        $iterLog += "RENAME FAILED after $attempt attempts (30s timeout)"
        Write-Host "  FAIL: Could not rename after 30 seconds" -ForegroundColor Red
    }
    
    # Log all failure reasons
    foreach ($fr in $failureReasons) {
        $iterLog += "  $fr"
    }
    
    $iterLog += ""
    $logContent += $iterLog
    
    # --- Cleanup ---
    if (Test-Path $testOldDir) { Remove-Item -Path $testOldDir -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path $testDir) { Remove-Item -Path $testDir -Recurse -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}

# --- Summary ---
$summary = @()
$summary += ""
$summary += "=" * 80
$summary += "SUMMARY"
$summary += "=" * 80
$summary += ""

$successes = ($allResults | Where-Object { $_.Renamed -eq $true }).Count
$failures = ($allResults | Where-Object { $_.Renamed -eq $false }).Count
$times = $allResults | Where-Object { $_.Renamed -eq $true } | ForEach-Object { $_.TimeMs }

$summary += "Total iterations: $iterations"
$summary += "Successes: $successes"
$summary += "Failures: $failures"
$summary += "Success rate: $([math]::Round($successes/$iterations*100, 1))%"
$summary += ""

if ($times.Count -gt 0) {
    $summary += "Time to successful rename (after process kill):"
    $summary += "  Min: $($times | Measure-Object -Minimum | Select -Expand Minimum)ms"
    $summary += "  Max: $($times | Measure-Object -Maximum | Select -Expand Maximum)ms"
    $summary += "  Avg: $([math]::Round(($times | Measure-Object -Average | Select -Expand Average), 0))ms"
    $summary += "  Median: $($times | Sort-Object | Select-Object -Index ([math]::Floor($times.Count/2)))ms"
    $summary += ""
    $summary += "Attempts distribution:"
    $groups = $allResults | Where-Object { $_.Renamed } | Group-Object { $_.Attempts }
    foreach ($g in $groups | Sort-Object Name) {
        $summary += "  $($g.Name) attempts: $($g.Count) times"
    }
}

$summary += ""
$summary += "Process counts at launch:"
$procCounts = $allResults | ForEach-Object { $_.ProcessCount }
$summary += "  Min: $($procCounts | Measure-Object -Minimum | Select -Expand Minimum)"
$summary += "  Max: $($procCounts | Measure-Object -Maximum | Select -Expand Maximum)"
$summary += "  Avg: $([math]::Round(($procCounts | Measure-Object -Average | Select -Expand Average), 1))"

$summary += ""
if ($failures -gt 0) {
    $summary += "FAILURE ANALYSIS:"
    $failedRuns = $allResults | Where-Object { $_.Renamed -eq $false }
    foreach ($fr in $failedRuns) {
        $summary += "  Iteration $($fr.Iteration): $($fr.FirstError)"
    }
}

$summary += ""
$summary += "CONCLUSION:"
if ($failures -eq 0 -and $times.Count -gt 0) {
    $avgTime = [math]::Round(($times | Measure-Object -Average | Select -Expand Average), 0)
    if ($avgTime -lt 1000) {
        $summary += "  Rename succeeds reliably within ~${avgTime}ms after process kill."
        $summary += "  CWD lock releases quickly after process death."
        $summary += "  Root cause of production failures is likely NOT the CWD alone."
    } elseif ($avgTime -lt 5000) {
        $summary += "  Rename succeeds but takes ${avgTime}ms on average."
        $summary += "  CWD lock takes significant time to release."
        $summary += "  Current 20s retry window should be sufficient but adds latency."
    } else {
        $summary += "  Rename takes >5 seconds consistently."
        $summary += "  CWD lock is a significant blocker."
        $summary += "  Architecture should not rely on rename of CWD directory."
    }
} elseif ($failures -gt 0) {
    $summary += "  RENAME FAILS in $failures/$iterations cases even after 30 seconds."
    $summary += "  CWD lock or other handle is a HARD BLOCKER."
    $summary += "  The rename-swap architecture CANNOT work without addressing this."
}

$logContent += $summary

# Write log file
$logContent | Out-File -FilePath $logFile -Encoding UTF8
Write-Host ""
Write-Host ($summary -join "`n")
Write-Host ""
Write-Host "Full log written to: $logFile" -ForegroundColor Cyan
