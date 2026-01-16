import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

// MongoDB Connection
export async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set in environment variables. Please check your .env file.');
  }
  
  try {
    await mongoose.connect(uri, {
      maxPoolSize: 10
    });
    logger.info('✅ Connected to MongoDB');
  } catch (error) {
    logger.error('❌ MongoDB connection error:', error.message);
    throw error;
  }
}

// JWT Configuration
export const jwtConfig = {
  accessTokenTtlSec: Number(process.env.JWT_ACCESS_TTL_SEC || 3600),
  refreshTokenTtlSec: Number(process.env.JWT_REFRESH_TTL_SEC || 1209600),
  secret: process.env.JWT_SECRET || 'change-me-in-env'
};

// JIRA Service
export const jiraConfig = {
  baseUrl: process.env.JIRA_BASE_URL,
  email: process.env.JIRA_EMAIL,
  apiToken: process.env.JIRA_API_TOKEN
};