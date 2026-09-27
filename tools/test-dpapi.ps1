$ErrorActionPreference = 'Stop'
Write-Output "PSVersion: $($PSVersionTable.PSVersion)"
try {
  Add-Type -AssemblyName System.Security
  $b = [Text.Encoding]::UTF8.GetBytes('hello')
  $p = [System.Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser')
  $u = [System.Security.Cryptography.ProtectedData]::Unprotect($p, $null, 'CurrentUser')
  Write-Output "DPAPI-OK: $([Text.Encoding]::UTF8.GetString($u))"
} catch {
  Write-Output "DPAPI-FAIL: $($_.Exception.Message)"
}
