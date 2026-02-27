/**
 * get_weather — Example tool for the tool-forge CLI demo.
 * Shape matches what the scanner (cli/tool-scanner.js) expects.
 */

export const getWeatherTool = {
  name: 'get_weather',
  description:
    'Retrieves current weather conditions for a city. Use when the user asks about current weather, temperature, or humidity. Source: OpenWeatherMap API.',
  schema: {
    city: { type: 'string' },
    units: { type: 'string', optional: true }
  },
  category: 'read',
  consequenceLevel: 'low',
  requiresConfirmation: false,
  timeout: 10000,
  version: '1.0.0',
  status: 'active',

  async execute(params, _context) {
    // EXTENSION POINT: call your weather API here
    // e.g. const data = await openWeatherMap.current(params.city, params.units);
    return {
      tool: 'get_weather',
      fetchedAt: new Date().toISOString(),
      data: null
    };
  }
};
