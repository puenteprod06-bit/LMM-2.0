$content = Get-Content 'D:\APPS\LMMAPP3.0\public\pos-venta.js' -Raw
$old = '{t.emoji||"restaurant"}</span>'
$new = '{t.emoji||"restaurant"}</span><img src="${getProductImagePriority(t).item_url}" alt="${t.name}" style="width:100%;height:80px;object-fit:cover;border-radius:8px;">'
if ($content -match [regex]::Escape($old)) {
  $content = $content -replace [regex]::Escape($old), $new
  Set-Content 'D:\APPS\LMMAPP3.0\public\pos-venta.js' -Value $content -Encoding utf8
  Write-Host 'Éxito al reemplazar la imagen del producto'
} else {
  Write-Host 'No se encontró el patrón de búsqueda'
  # Mostrar qué hay alrededor de la posición 4556
  $content.substring(4550, 30) | Write-Host
}