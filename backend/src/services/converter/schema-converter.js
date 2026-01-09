/**
 * Convert OpenAI/Gemini tool schema and media into Antigravity/Gemini-compatible shapes.
 */

export function convertTool(tool) {
    const func = tool.function || tool;

    return {
        name: func.name,
        description: func.description || '',
        parameters: convertJsonSchema(func.parameters)
    };
}

/**
 * Convert JSON Schema (remove unsupported fields; optionally uppercase types).
 * @param {Object} schema JSON Schema
 * @param {boolean} uppercaseTypes Gemini expects uppercase; Claude expects lowercase.
 */
export function convertJsonSchema(schema, uppercaseTypes = true) {
    if (!schema) return undefined;

    const converted = { ...schema };

    // remove unsupported fields
    delete converted.$schema;
    delete converted.additionalProperties;
    delete converted.propertyNames;
    delete converted.default;
    delete converted.minLength;
    delete converted.maxLength;
    delete converted.minimum;
    delete converted.maximum;
    delete converted.minItems;
    delete converted.maxItems;
    delete converted.pattern;
    delete converted.format;
    delete converted.uniqueItems;
    delete converted.exclusiveMinimum;
    delete converted.exclusiveMaximum;

    if (converted.type && uppercaseTypes) {
        converted.type = converted.type.toUpperCase();
    }

    if (converted.properties) {
        converted.properties = {};
        for (const [key, value] of Object.entries(schema.properties)) {
            converted.properties[key] = convertJsonSchema(value, uppercaseTypes);
        }
    }

    if (converted.items) {
        converted.items = convertJsonSchema(schema.items, uppercaseTypes);
    }

    return converted;
}

/**
 * Parse data URL (or raw base64) into {mimeType,data}
 */
export function parseDataUrl(url) {
    // support data URL or raw base64
    if (url.startsWith('data:')) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
            return {
                mimeType: match[1],
                data: match[2]
            };
        }
    }

    // assume raw base64 PNG
    return {
        mimeType: 'image/png',
        data: url
    };
}

/**
 * Generate sessionId
 */
export function generateSessionId() {
    return String(-Math.floor(Math.random() * 9e18));
}
