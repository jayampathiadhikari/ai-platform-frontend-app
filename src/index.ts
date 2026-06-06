import express from "express";
import type { Request, Response } from "express";

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());

app.post("/run", (req: Request, res: Response) => {
  const body = req.body;

  console.log("[POST /run] received:", body);

  res.json({ ok: true, received: body });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
