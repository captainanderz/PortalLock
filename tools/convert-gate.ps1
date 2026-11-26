# Converts the Dark Portal, as exported by wow.export, into what the animation loads (PortalLock\web\gate
# and gate.js), and bakes the light on its stone. The work is done by convert-gate.py inside Blender;
# this finds Blender and runs it. It takes a few minutes.
#
#   powershell -File tools\convert-gate.ps1 [-Export <wow.export folder>] [-Blender <path to blender.exe>]
param(
  [string]$Export = (Join-Path $env:USERPROFILE 'wow.export'),
  [string]$OutDir = (Join-Path $PSScriptRoot '..\PortalLock\web'),
  [string]$Blender
)
$ErrorActionPreference = 'Stop'

# What wow.export must have written (as OBJ, with the .json it writes next to the WMO).
$needed = [ordered]@{
  'world\wmo\outland\darkportal\darkportal_temple.obj'                              = 'world/wmo/outland/darkportal/darkportal_temple.wmo'
  'world\wmo\outland\darkportal\darkportal_temple.json'                             = 'world/wmo/outland/darkportal/darkportal_temple.wmo'
  'world\expansion01\doodads\hellfirepeninsula\darkportal\hellfire_darkportal_fx.obj' = 'world/expansion01/doodads/hellfirepeninsula/darkportal/hellfire_darkportal_fx.m2'
  'environments\stars\hellfireskybox.obj'                                           = 'environments/stars/hellfireskybox.m2'
}
foreach ($file in $needed.Keys) {
  if (-not (Test-Path (Join-Path $Export $file))) {
    throw "$(Join-Path $Export $file) is missing. Export $($needed[$file]) with wow.export (as OBJ), or pass -Export <folder wow.export exports to>."
  }
}

if (-not $Blender) {
  $Blender = (Get-Command blender -ErrorAction SilentlyContinue).Source
  if (-not $Blender) {
    $Blender = Get-ChildItem 'C:\Program Files\Blender Foundation\*\blender.exe' -ErrorAction SilentlyContinue |
      Sort-Object { $_.VersionInfo.FileVersionRaw } | Select-Object -Last 1 -ExpandProperty FullName
  }
  if (-not $Blender) { throw 'Blender was not found. Install it, or pass -Blender <path to blender.exe>.' }
}

& $Blender --background --factory-startup --python-exit-code 1 --python (Join-Path $PSScriptRoot 'convert-gate.py') `
  -- (Resolve-Path $Export).Path (Resolve-Path $OutDir).Path
if ($LASTEXITCODE -ne 0) { throw "Blender stopped with an error (exit code $LASTEXITCODE)." }
