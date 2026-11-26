$content = Get-Content 'D:\APPS\LMMAPP3.0\public\pos-menu.js' -Raw

# Reemplazar las tabs de categorías - buscar el patrón exacto
$oldString = '<span style="font-weight:600; color:var(--text)">${e.name}</span>'
$newString = '<span style="font-weight:600; color:var(--text)">${e.name}</span>'  # Igual por ahora

# Buscar el patrón de la tab y reemplazar todo el bloque
if ($content -match 'onclick="fmCat') {
  # Reemplazar el div tab por button pos-cat
  $pattern = 'class="tab" onclick="fmCat'
  $replacement = 'class="pos-cat" onclick="window._posCat='
  
  if ($content -match $pattern) {
    $content = $content -replace $pattern, $replacement
    Write-Host 'Patrón encontrado y reemplazado parcialmente'
  }
}

Set-Content 'D:\APPS\LMMAPP3.0\public\pos-menu.js' -Value $content -Encoding utf8
Write-Host 'Proceso completado'