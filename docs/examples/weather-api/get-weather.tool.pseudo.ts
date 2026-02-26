// ============================================================================
// get-weather.tool — PSEUDO-CODE worked example
//
// This shows what /forge-tool produces for a weather API tool.
// Adapt to your stack (Zod → your validator, etc.). Invalid as-is (placeholder imports).
// ============================================================================

import { VALIDATE } from '/* your validation library */';

// Schema: the inputs this tool accepts
const schema = VALIDATE.object({
  city: VALIDATE.string()
    .required()
    .describe('City name or "city, country code" (e.g., "Paris" or "Paris, FR")'),
  units: VALIDATE.enum(['metric', 'imperial', 'kelvin'])
    .default('metric')
    .describe('Temperature units'),
});

// ToolDefinition
export const getWeatherTool = {
  name: 'get_weather',

  description:
    'Fetches current weather conditions for a city from the OpenWeather API. ' +
    'Use when the user asks about current weather, temperature, or conditions ' +
    'for a specific location. For weather forecasts, use get_forecast instead.',

  category: 'read',
  consequenceLevel: 'low',
  requiresConfirmation: false,
  timeout: 15000,
  tags: ['weather', 'external-api'],
  schema,

  execute: async (params, context) => {
    // Always check cancellation before I/O
    if (context.abortSignal?.aborted) {
      return {
        tool: 'get_weather',
        fetchedAt: new Date().toISOString(),
        error: 'Request was cancelled',
      };
    }

    try {
      const { city, units } = schema.parse(params);

      // Call the external API via context.client
      const data = await context.client.get(
        `/weather?q=${encodeURIComponent(city)}&units=${units}`,
        context.auth
      );

      return {
        tool: 'get_weather',
        fetchedAt: new Date().toISOString(),
        data: {
          city: data.name,
          country: data.sys?.country,
          temperature: data.main?.temp,
          feelsLike: data.main?.feels_like,
          humidity: data.main?.humidity,
          conditions: data.weather?.[0]?.description,
          windSpeed: data.wind?.speed,
          units,
        },
      };
    } catch (err) {
      return {
        tool: 'get_weather',
        fetchedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
