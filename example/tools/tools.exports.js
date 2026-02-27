/**
 * Barrel registry for example tools.
 * The CLI scanner (cli/tool-scanner.js) reads this file to discover registered tools.
 */

export { getWeatherTool } from './get_weather.tool.js';
export { getForecastTool } from './get_forecast.tool.js';
