$content = Get-Content 'D:\APPS\LMMAPP3.0\public\pos-dashboard.js' -Raw
# Reemplazar la línea con setTimeout
$oldLine = 'setTimeout(()=>{updateDashboardChart("today")},200)}'
$newLine = 'updateDashboardChart("today")'
if ($content -match [regex]::Escape($oldLine)) {
  $content = $content -replace [regex]::Escape($oldLine), $newLine
  Set-Content 'D:\APPS\LMMAPP3.0\public\pos-dashboard.js' -Value $content -Encoding utf8
  Write-Host 'Línea reemplazada exitosamente'
} else {
  Write-Host 'No se encontró la línea exacta'
  # Mostrar qué hay en la línea 7311
  $lines = $content -split "`n"
  if ($lines[7310]) {
    Write-Host 'Línea 7311: ' $lines[7310]
  }
}