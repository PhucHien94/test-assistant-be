import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
dotenv.config();
import { connectMongo } from './config/index.js';
import authRouter from './routes/auth.js';
import generationsRouter from './routes/generations.js';
import { logger } from './utils/logger.js';

const app = express();

// CORS Configuration
app.use(cors({
    origin: process.env.CORS_ORIGIN,
    credentials: true
}));

// Body Parser - Parse JSON request bodies
app.use(express.json({ limit: '10mb' }));

// HTTP Request Logging
app.use(morgan('dev'));

// Health Check Endpoint
app.get('/severStatus',(req,res)=>{
    res.json({
        status: 'OK',
        timestamp:new Date().toISOString(),
        service: 'sdetpro-test-assistant-be'
    })
});

// Connect to MongoDB
connectMongo().catch((err) => {
  logger.error('Mongo connection error:', err);
  process.exit(1);
});

// Routes
app.use('/auth', authRouter);
app.use('/generations', generationsRouter);


// Log registered routes
logger.info('✅ Registered routes:');
logger.info('  POST /auth/register');

// 404 Handler - Route not found
app.use((req, res) => {
  logger.info(`404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({ 
    success: false, 
    error: `Route not found: ${req.method} ${req.path}` 
  });
});

// Error Handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  logger.error('Error:', err);
  res.status(status).json({ 
    success: false, 
    error: err.message || 'Internal Server Error' 
  });
});

//export default app;
export default app;