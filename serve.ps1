# Локальный сервер для книги.
# Запуск:  .\serve.ps1          (порт 8080)
#          .\serve.ps1 -Port 9000
param([int]$Port = 8080)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -First 1).IPAddress

Write-Host ''
Write-Host '  The Cake of English Tenses - интерактивная книга' -ForegroundColor Yellow
Write-Host "  На этом компьютере:  http://localhost:$Port"
if ($ip) { Write-Host "  С телефона в той же сети:  http://${ip}:$Port" -ForegroundColor Cyan }
Write-Host '  Остановить: Ctrl + C'
Write-Host ''

py -3 -m http.server $Port --bind 0.0.0.0
