import { Hono } from "hono";
import "./db.ts";

const app = new Hono();

app.get("/", (c) => {
	return c.text("Hello via index route handler!");
	// return c.json({
	//   data: 'Hello from the JSON response!',
	// });
});

console.log("Hello via index!");

export default app;
