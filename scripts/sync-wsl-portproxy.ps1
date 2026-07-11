# ─── WSL2 Port Proxy Sync ────────────────────────────────────
# Syncs netsh portproxy rules to the current WSL2 internal IP.
#
# WSL2 (NAT mode) assigns a new internal IP on every restart,
# breaking any portproxy rules that forward LAN traffic into
# WSL2 services. This script detects the current IP and
# re-creates the forwarding rules.
#
# Usage (elevated PowerShell):
#   .\sync-wsl-portproxy.ps1
#   .\sync-wsl-portproxy.ps1 -Ports 8080,1234
#   .\sync-wsl-portproxy.ps1 -DryRun
#
# Automation (Task Scheduler):
#   Trigger: "At log on" or "At startup"
#   Action:  powershell -ExecutionPolicy Bypass -File "C:\path\to\sync-wsl-portproxy.ps1"
#   Run as:  Administrator (required for netsh)
# ─────────────────────────────────────────────────────────────

param(
    [int[]]$Ports = @(8080, 1234),
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# ── Resolve current WSL2 IP ──────────────────────────────────
$wslIp = (wsl hostname -I 2>$null)
if (-not $wslIp) {
    Write-Host "[ERROR] WSL is not running or hostname -I returned empty." -ForegroundColor Red
    exit 1
}
$wslIp = $wslIp.Trim().Split(" ")[0]

if ($wslIp -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
    Write-Host "[ERROR] Invalid WSL2 IP: '$wslIp'" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  WSL2 Port Proxy Sync" -ForegroundColor Cyan
Write-Host "  WSL2 IP: $wslIp" -ForegroundColor Gray
Write-Host ""

# ── Parse existing portproxy rules ───────────────────────────
$existingRules = @{}
$proxyOutput = netsh interface portproxy show v4tov4 2>$null
foreach ($line in $proxyOutput) {
    if ($line -match '^\s*(\S+)\s+(\d+)\s+(\S+)\s+(\d+)\s*$') {
        $listenAddress = $Matches[1]
        $listenPort = [int]$Matches[2]
        $connectAddress = $Matches[3]
        $connectPort = [int]$Matches[4]
        $existingRules[$listenPort] = @{
            ListenAddress  = $listenAddress
            ConnectAddress = $connectAddress
            ConnectPort    = $connectPort
        }
    }
}

# ── Sync each port ───────────────────────────────────────────
foreach ($port in $Ports) {
    $existing = $existingRules[$port]

    if ($existing -and $existing.ConnectAddress -eq $wslIp) {
        Write-Host "  [SKIP]   :$port -> $wslIp:$port (already correct)" -ForegroundColor DarkGray
        continue
    }

    if ($existing) {
        $staleIp = $existing.ConnectAddress
        Write-Host "  [UPDATE] :$port -> $staleIp:$port (stale) -> $wslIp:$port" -ForegroundColor Yellow
        if (-not $DryRun) {
            netsh interface portproxy delete v4tov4 listenport=$port listenaddress=$($existing.ListenAddress) >$null 2>&1
        }
    } else {
        Write-Host "  [ADD]    :$port -> $wslIp:$port (new rule)" -ForegroundColor Green
    }

    if (-not $DryRun) {
        netsh interface portproxy add v4tov4 listenport=$port listenaddress=0.0.0.0 connectport=$port connectaddress=$wslIp >$null 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [FAIL]   Could not add rule for port $port (run as Administrator)" -ForegroundColor Red
        }
    } else {
        Write-Host "           (dry run — no changes made)" -ForegroundColor DarkGray
    }
}

# ── Ensure firewall rules exist ──────────────────────────────
foreach ($port in $Ports) {
    $ruleName = "WSL2 Port Forward - $port"
    $existingFirewallRule = netsh advfirewall firewall show rule name="$ruleName" dir=in 2>$null

    if ($existingFirewallRule -match "No rules match") {
        Write-Host "  [FW]     Adding firewall rule for port $port" -ForegroundColor Cyan
        if (-not $DryRun) {
            netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=TCP localport=$port >$null 2>&1
        }
    }
}

Write-Host ""
Write-Host "  Done." -ForegroundColor Green
Write-Host ""
