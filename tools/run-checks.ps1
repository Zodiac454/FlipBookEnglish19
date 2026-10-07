# Полная проверка книги в реальном браузере.
#   .\tools\run-checks.ps1
# Поднимает локальный сервер, открывает headless Chrome, прогоняет проверки
# (обычный режим, телефонные профили, тач-жесты, регрессии по ревью, сверка
# скриншотов со страницами PDF) и складывает скриншоты в tools\_checks\.

param(
    [int]$Port = 8123,
    [int]$DebugPort = 9222,
    [switch]$SkipPixel
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$shots = Join-Path $PSScriptRoot '_checks'
$profile = Join-Path $env:TEMP 'cake-checks'
$chromePath = @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chromePath) { throw 'Не найден Chrome' }

function Test-PortBusy([int]$P) {
    try {
        $client = New-Object Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', $P)
        $client.Close()
        return $true
    } catch { return $false }
}

# Порт должен быть свободен: иначе проверки уйдут на чужой сервер
if (Test-PortBusy $Port) { throw "Порт $Port занят — проверки могут уйти на чужой сервер. Освободите порт." }
if (Test-PortBusy $DebugPort) { throw "Порт $DebugPort занят — не подключиться к Chrome." }

New-Item -ItemType Directory -Force $shots | Out-Null
Get-ChildItem $shots -File -ErrorAction SilentlyContinue | Remove-Item -Force

# Свежий профиль браузера: иначе HTTP-кэш может отдать старые style.css и app.js,
# и прогон покажет зелёный результат на прошлой версии кода.
if (Test-Path $profile) { Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue }

$server = Start-Process -FilePath 'py' -ArgumentList '-3', '-m', 'http.server', $Port, '--bind', '127.0.0.1' `
    -WorkingDirectory $root -PassThru -WindowStyle Hidden
$chrome = Start-Process -FilePath $chromePath -ArgumentList @(
    '--headless=new', "--remote-debugging-port=$DebugPort", "--user-data-dir=$profile",
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars',
    '--incognito', '--window-size=1440,900', 'about:blank'
) -PassThru -WindowStyle Hidden

try {
    Start-Sleep 5
    $url = "http://127.0.0.1:$Port/"

    # Сервер должен не только отвечать, но и отдавать именно те файлы, что лежат на диске
    foreach ($rel in 'index.html', 'assets/style.css', 'assets/app.js', 'pages/p001.webp') {
        $served = Invoke-WebRequest -Uri "$url$rel" -UseBasicParsing -TimeoutSec 15
        $disk = (Get-Item (Join-Path $root ($rel -replace '/', '\'))).Length
        if ($served.RawContentLength -ne $disk) {
            throw "Сервер отдаёт устаревший ${rel}: $($served.RawContentLength) байт вместо $disk. Прогон остановлен."
        }
    }
    Write-Host "Сервер отдаёт актуальные файлы." -ForegroundColor Green

    $env:SHOT_DIR = $shots
    $env:CDP_PORT = "$DebugPort"

    Write-Host "`n=== 1/5 Основные сценарии (ПК) ===" -ForegroundColor Yellow
    node (Join-Path $PSScriptRoot 'verify.mjs') $url

    Write-Host "`n=== 2/5 Телефоны и тач-жесты ===" -ForegroundColor Yellow
    node (Join-Path $PSScriptRoot 'verify-mobile.mjs') $url

    Write-Host "`n=== 3/5 Регрессии по ревью ===" -ForegroundColor Yellow
    node (Join-Path $PSScriptRoot 'verify-regressions.mjs') $url

    if (-not $SkipPixel) {
        Write-Host "`n=== 4/5 Сверка экрана со страницами PDF ===" -ForegroundColor Yellow
        py -3 (Join-Path $PSScriptRoot 'compare-screenshots.py') $shots

        Write-Host "`n=== 5/5 Визуальная композиция снимков ===" -ForegroundColor Yellow
        py -3 (Join-Path $PSScriptRoot 'check-visuals.py') $shots
    }

    Write-Host "`nСкриншоты: $shots" -ForegroundColor Green
}
finally {
    taskkill /T /F /PID $chrome.Id 2>&1 | Out-Null
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}
