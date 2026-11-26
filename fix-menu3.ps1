$content = Get-Content 'D:\APPS\LMMAPP3.0\public\pos-menu.js' -Raw

# Reemplazar el onclick de las tabs de categorías - hacerlo más sencillo
$oldOnclick = 'onclick=""window._posCat=(${e.id},this)"'
$newOnclick = 'onclick=""window._posCat=' + chr(39) + '${e.id}' + chr(39) + '; window._posSubcat=null; renderPOS()"'

Write-Host 'Old onclick pattern length: ' + (($oldOnclick).length)
Write-Host 'New onclick pattern length: ' + (($newOnclick).length)

if ($content -match $oldOnclick) {
  $content = $content -replace $oldOnclick, $newOnclick
  Write-Host 'Patrón onclick modificado exitosamente'
} else {
  Write-Host 'No se encontró el patrón onclick original'
  # Mostrar qué hay alrededor de la posición esperada
  $pos = $content.indexOf('window._posCat')
  if ($pos > 0) {
    Write-Host 'Posición encontrada en: ' + $pos
    Write-Host 'Contexto: ' + $content.substring($pos-10, $pos+30)
  }
}

# Ahora reemplazar el div tab por button pos-cat
$oldDiv = '<div class="pos-cat" onclick="window._posCat=(${e.id},this)">'
$newButtonStart = '<button class="pos-cat" onclick="window._posCat='

if ($content -oldDiv) {
  $content = $content -replace $oldDiv, $newButtonStart
  Write-Host 'Div tab reemplazado por botón inicio'
} else {
  Write-Host 'No se encontró el div exacto para reemplazar'
}

Set-Content 'D:\APPS\LMMAPP3.0\public\pos-menu.js' -Value $content -Encoding utf8
Write-Host 'Proceso completado - archivo guardado'