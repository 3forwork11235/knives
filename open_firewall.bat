@echo off
chcp 65001 >nul
:: Opens TCP port 8766 in Windows Firewall so phones/tablets in your Wi-Fi can connect.
:: Run once. Asks for administrator rights.

net session >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

netsh advfirewall firewall delete rule name="Knives game 8766" >nul 2>&1
netsh advfirewall firewall add rule name="Knives game 8766" dir=in action=allow protocol=TCP localport=8766 profile=private,public
if errorlevel 1 (
    echo [!] Failed to add the firewall rule.
) else (
    echo [+] Port 8766 is open. Phones can now connect to the game server.
)
echo.
echo To remove the rule later run:
echo   netsh advfirewall firewall delete rule name="Knives game 8766"
echo.
pause
