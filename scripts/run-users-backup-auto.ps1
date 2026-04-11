$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repoRoot

$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
& $npmCommand run users:backup:auto
exit $LASTEXITCODE
