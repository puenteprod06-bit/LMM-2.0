# Imágenes automáticas de productos en Venta

Las imágenes de `public/assets/productos/` se asignan automáticamente según el nombre del producto. No hace falta subir la imagen en el formulario de cada producto.

## Prioridad de resolución

1. Imagen personalizada del producto (`image_url`).
2. **Coincidencia automática por variantes del nombre** (esta nueva regla).
3. Imagen heredada de la subcategoría.
4. Imagen heredada de la categoría.
5. `public/assets/default-product.png`.

La comparación ignora mayúsculas, acentos y puntuación. Coincidencias exactas tienen prioridad sobre coincidencias parciales; si un nombre contiene varias variantes, gana la más específica (por ejemplo, `Pizza Grande` no usa la imagen de `Pizza Chica`).

## Archivos y variantes

| Archivo | Variantes reconocidas |
|---|---|
| `hamburguesa-doble.jpg` | hamburguesa doble, hamburguesa doble carne, hamburguesa de doble carne, doble hamburguesa, doble carne, hamburguesa doble cheddar, hamburguesa doble bacon, hamburguesa doble queso, hamburguesa 2 carne, hamburguesa dos carnes, hamburguesa clásica doble |
| `hamburguesa-simple.jpg` | hamburguesa simple, hamburguesa sencilla, hamburguesa clásica, hamburguesa clásica simple, hamburguesa normal, hamburguesa individual, hamburguesa 1 carne, hamburguesa una carne, hamburguesa común |
| `Pizza-grande.jpg` | pizza grande, pizza familiar, pizza grande familiar, pizza 1 kilo, pizza kilo, pizza grande kilo, pizza grande 1 kilo |
| `Pizza-chica.jpg` | pizza chica, pizza pequeña, pizza pequeño, pizza individual, pizza mini, pizza, pizza chica personal |

## Notas

- El producto `Hamburguesa Clásica` existente usa `hamburguesa-simple.jpg`.
- El producto `Hamburguesa Doble` existente usa `hamburguesa-doble.jpg`.
- El producto `pizza` existente, al no indicar tamaño, usa `Pizza-chica.jpg`. Si se crea `Pizza Grande` o `Pizza Familiar`, usa `Pizza-grande.jpg` automáticamente.
- Las imágenes se sirven desde `/assets/productos/...` y se muestran con `object-fit: cover` ocupando el 50% de la card.
