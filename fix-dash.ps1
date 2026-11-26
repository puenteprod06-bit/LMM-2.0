$content = Get-Content 'D:\APPS\LMMAPP3.0\public\pos-dashboard.js' -Raw
$old = '`$\\`\\`\\`  </div>`,setTimeout(()=>{updateDashboardChart'
$new = '`$\\`\\`\\`  </div>`,updateDashboardChart'
if ($content -match $old) {
  $content = $content -replace $old, $new
  Set-Content 'D:\APPS\LMMAPP3.0\public\pos-dashboard.js' -Value $content -Encoding utf8
  Write-Host 'Éxito al remover setTimeout'
} else {
  Write-Host 'No se encontró el patrón'
}