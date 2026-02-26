// ============================================================================
// get-weather.mcp — MCP server generated from the ToolDefinition above
//
// This shows what /forge-mcp produces from the get_weather ToolDefinition.
// ============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_BASE_URL = process.env.OPENWEATHER_BASE_URL || "https://api.openweathermap.org/data/2.5";
const API_KEY = process.env.OPENWEATHER_API_KEY;

const server = new McpServer({
  name: "weather-mcp-server",
  version: "1.0.0"
});

// Input schema — converted from the ToolDefinition's schema
const GetWeatherInputSchema = z.object({
  city: z.string()
    .min(1, "City name is required")
    .describe('City name or "city, country code" (e.g., "Paris" or "Paris, FR")'),
  units: z.enum(["metric", "imperial", "kelvin"])
    .default("metric")
    .describe("Temperature units")
}).strict();

type GetWeatherInput = z.infer<typeof GetWeatherInputSchema>;

// Tool registration — mapped from ToolDefinition fields
server.registerTool(
  "get_weather",
  {
    title: "Get Current Weather",
    description:
      "Fetches current weather conditions for a city from the OpenWeather API. " +
      "Use when the user asks about current weather, temperature, or conditions " +
      "for a specific location. For weather forecasts, use get_forecast instead.",
    inputSchema: GetWeatherInputSchema,
    annotations: {
      readOnlyHint: true,       // category: 'read'
      destructiveHint: false,    // consequenceLevel: 'low'
      idempotentHint: true,      // reads are idempotent
      openWorldHint: true        // calls OpenWeather API
    }
  },
  async (params: GetWeatherInput) => {
    try {
      const url = `${API_BASE_URL}/weather?q=${encodeURIComponent(params.city)}&units=${params.units}&appid=${API_KEY}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        if (response.status === 404) {
          return {
            content: [{ type: "text" as const, text: `Error: City "${params.city}" not found.` }],
            isError: true
          };
        }
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json() as any;

      const weather = {
        city: data.name,
        country: data.sys?.country,
        temperature: data.main?.temp,
        feelsLike: data.main?.feels_like,
        humidity: data.main?.humidity,
        conditions: data.weather?.[0]?.description,
        windSpeed: data.wind?.speed,
        units: params.units
      };

      const unitLabel = params.units === "imperial" ? "°F" : params.units === "kelvin" ? "K" : "°C";

      const text = [
        `# Weather in ${weather.city}, ${weather.country}`,
        "",
        `- **Temperature:** ${weather.temperature}${unitLabel} (feels like ${weather.feelsLike}${unitLabel})`,
        `- **Conditions:** ${weather.conditions}`,
        `- **Humidity:** ${weather.humidity}%`,
        `- **Wind:** ${weather.windSpeed} ${params.units === "imperial" ? "mph" : "m/s"}`
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: weather
      };
    } catch (error) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }
);

async function main() {
  if (!API_KEY) {
    console.error("ERROR: OPENWEATHER_API_KEY environment variable is required");
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("weather-mcp-server running via stdio");
}

main().catch(error => {
  console.error("Server error:", error);
  process.exit(1);
});
