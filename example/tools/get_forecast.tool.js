/**
 * get_forecast — Example tool for the tool-forge CLI demo.
 * Shape matches what the scanner (lib/tools-scanner.js) expects.
 */

export const getForecastTool = {
  name: 'get_forecast',
  description:
    'Retrieves a multi-day weather forecast for a city. Use when the user asks about forecast, prediction, outlook, or precipitation over coming days. Source: OpenWeatherMap API.',
  schema: {
    city: { type: 'string' },
    days: { type: 'number', optional: true },
    units: { type: 'string', optional: true }
  },
  category: 'read',
  consequenceLevel: 'low',
  requiresConfirmation: false,
  timeout: 10000,
  version: '1.0.0',
  status: 'active',

  async execute(params, _context) {
    // EXTENSION POINT: call your forecast API here
    // e.g. const data = await openWeatherMap.forecast(params.city, params.days, params.units);
    return {
      tool: 'get_forecast',
      fetchedAt: new Date().toISOString(),
      data: null
    };
  }
};
