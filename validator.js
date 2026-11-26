// validator.js o bloque inicial en server.js
const Validator = {
  // Reglas comunes predefinidas
  patterns: {
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    pin: /^\d{4}$/, // Exactamente 4 números
    slug: /^[a-z0-9-]+$/
  },

  validate(rules, data) {
    const errors = [];
    const sanitized = {};

    for (const field in rules) {
      const rule = rules[field];
      let value = data[field];

      // 1. Sanitización básica (Trimming de strings)
      if (typeof value === 'string') value = value.trim();

      // 2. Verificación de Obligatoriedad
      if (rule.required && (value === undefined || value === null || value === '')) {
        errors.push(`El campo '${field}' es obligatorio.`);
        continue;
      }

      // Si el campo es opcional y está vacío, saltar validaciones de tipo
      if (!rule.required && (value === undefined || value === null || value === '')) {
        sanitized[field] = value;
        continue;
      }

      // 3. Validación de Tipos
      if (rule.type === 'number') {
        value = parseFloat(value);
        if (isNaN(value)) {
          errors.push(`El campo '${field}' debe ser un número.`);
        } else if (rule.positive && value < 0) {
          errors.push(`El campo '${field}' no puede ser negativo.`);
        }
      }

      // 4. Validación de Longitud (Strings)
      if (rule.type === 'string') {
        if (rule.minLen && value.length < rule.minLen) {
          errors.push(`El campo '${field}' es demasiado corto (mín. ${rule.minLen}).`);
        }
        if (rule.maxLen && value.length > rule.maxLen) {
          errors.push(`El campo '${field}' es demasiado largo (máx. ${rule.maxLen}).`);
        }
      }

      // 5. Validación por Regex (Patterns)
      if (rule.pattern && this.patterns[rule.pattern]) {
        if (!this.patterns[rule.pattern].test(value)) {
          errors.push(`El formato de '${field}' es inválido.`);
        }
      }

      sanitized[field] = value;
    }

    return {
      valid: errors.length === 0,
      errors,
      data: sanitized
    };
  }
};

module.exports = Validator;