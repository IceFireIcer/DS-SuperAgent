param(
  [Parameter(Mandatory)][string]$PreviousInstaller,
  [Parameter(Mandatory)][string]$NextInstaller,
  [Parameter(Mandatory)][string]$NextAppAsar
)

$ErrorActionPreference = 'Stop'
if ((node --version) -notmatch '^v24\.') { throw 'Use Node 24 for the T55 install check.' }
$previous = (Resolve-Path -LiteralPath $PreviousInstaller).Path
$next = (Resolve-Path -LiteralPath $NextInstaller).Path
$expected = (Get-FileHash -LiteralPath $NextAppAsar).Hash
$registry = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')

function Find-ProductRegistration {
  foreach ($key in $registry) {
    Get-ChildItem -LiteralPath $key -ErrorAction SilentlyContinue |
      ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } |
      Where-Object DisplayName -Like 'DS SuperAgent*'
  }
}

$shortcuts = @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'DS SuperAgent.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'DS SuperAgent.lnk'))
if ((Find-ProductRegistration) -or (Get-Process -Name 'DS SuperAgent' -ErrorAction SilentlyContinue) -or
    (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Programs/DS SuperAgent')) -or
    ($shortcuts | Where-Object { Test-Path -LiteralPath $_ })) {
  throw 'The T55 install check requires a Windows account without an active DS SuperAgent installation.'
}

$tempRoot = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path.TrimEnd('\')
$fixture = Join-Path $tempRoot ('ds-superagent-t55-install-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $fixture | Out-Null
$program = Join-Path $fixture 'program'
$executable = Join-Path $program 'DS SuperAgent.exe'
$uninstaller = Join-Path $program 'Uninstall DS SuperAgent.exe'
try {
  $setup = Start-Process -FilePath $previous -ArgumentList @('/S','/no-desktop-shortcut',"/D=$program") -WindowStyle Hidden -Wait -PassThru
  if ($setup.ExitCode -ne 0 -or !(Test-Path -LiteralPath $executable)) { throw 'The previous installer did not install the app in its test directory.' }
  Write-Output 'T55 previous NSIS install passed.'
  node (Join-Path $PSScriptRoot 'check-packed.mjs') $executable --upgrade-with $next
  if ($LASTEXITCODE -ne 0) { throw 'The packaged profile did not survive the installed upgrade.' }
  if ((Get-FileHash -LiteralPath (Join-Path $program 'resources/app.asar')).Hash -ne $expected) {
    throw 'The installed application data does not match the next build.'
  }
  Write-Output "T55 updated app.asar SHA-256 $expected"
} finally {
  if (Test-Path -LiteralPath $uninstaller) {
    $remove = Start-Process -FilePath $uninstaller -ArgumentList @('/currentuser','/S') -WindowStyle Hidden -Wait -PassThru
    if ($remove.ExitCode -ne 0) { throw 'The temporary app did not uninstall.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    while ((Test-Path -LiteralPath $executable) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 300 }
  }
  if ((Find-ProductRegistration) -or (Test-Path -LiteralPath $executable) -or
      ($shortcuts | Where-Object { Test-Path -LiteralPath $_ })) { throw 'The temporary install did not finish cleaning up.' }
  $resolved = (Resolve-Path -LiteralPath $fixture).Path
  if ((Split-Path -Parent $resolved) -ne $tempRoot -or (Split-Path -Leaf $resolved) -notmatch '^ds-superagent-t55-install-[a-f0-9]{8}$') {
    throw 'The install check cleanup path is outside its temporary directory.'
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
  Write-Output 'T55 temporary NSIS install and registration cleaned up.'
}
