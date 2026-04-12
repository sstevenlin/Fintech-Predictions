import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { logger } from './utils/logger.js';
import { healthRouter } from './routes/health.js';

const app = express();
const PORT = process.env.PORT ?? 3000;

// headers
app.use(helmet());
app.use(cors());
app.use(express.json());

// routes
app.use('/health', healthRouter);

// global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});
