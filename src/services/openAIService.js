import dotenv from 'dotenv';
dotenv.config();

import OpenAI from 'openai';
import { logger } from '../utils/logger.js';

const MANUAL_PROMPT = `You are an expert manual QA Engineer. Generate comprehensive test cases from JIRA issue descriptions.

**Context:** You will receive JIRA issue details including title, description, comments, and acceptance criteria. Use ONLY this information - never invent requirements.

**Output Requirements:**
1. Use proper markdown with ## for main headings and - for bullet points
2. Include a title: "# Test Cases for [JIRA-ID]: [Issue Title]"
3. Structure by categories: ## **Functional Requirements**, ## **UI & Visual Validation**, ## **Edge Cases**, ## **Data Integrity** (if applicable)
4. Include blank lines before and after lists
5. Each test case should be:
   - Clear and actionable
   - Cover specific acceptance criteria
   - Include preconditions, steps, and expected results
   - Prioritized (High/Medium/Low)

**Must NOT:**
- Never mention specific individual names
- Never include implementation details (HTML classes, functions)
- Never invent requirements not in the JIRA issue

**Coverage:**
- Positive and negative test cases
- Edge cases and boundary conditions
- Error handling
- User workflows
- Form validations
- State transitions
- Accessibility considerations (if UI-related)

Generate comprehensive test cases now.`;

const AUTO_PROMPT = `You are an expert QA automation specialist. Generate automation-friendly test cases from JIRA issue descriptions.

**Context:** You will receive JIRA issue details. Use ONLY this information - never invent requirements.

**Output Requirements:**
1. Use proper markdown format
2. Title: "# Automation Tests for [JIRA-ID]: [Issue Title]"
3. Structure tests by acceptance criteria
4. Include blank lines before and after lists
5. Each test should specify:
   - Clear, automatable steps
   - Specific UI elements or data to verify
   - Assertion points
   - Test data requirements

**Must NOT:**
- Never include subjective validations
- Never write vague steps
- Never include non-verifiable assertions

**Focus on:**
- Idempotent, independent test scenarios
- Clear element identification strategies
- Repeatable test data
- Programmatically verifiable assertions
- Error handling in automation
- State management

Generate automation-friendly test cases now.`;

export default class OpenAIService {
    constructor() {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error("OPENAI_API_KEY is not ");
        }

        this.client = new OpenAI({ apiKey });
        this.model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
        this.maxCompletionTokens = 8000;
        this.maxRetries = 3;
    }

    async generateTestCase(context, issueKey, autoMode = false, images = []) {
        try {
            const systemPrompt = autoMode ? AUTO_PROMPT : MANUAL_PROMPT;

            // Build user message content
            const issueContext = `\n\nJIRA issue: ${issueKey}\n\n${context}`;
            const messages = [
                {
                    role: 'system',
                    content: systemPrompt
                }
            ];

            let userMessage = {
                role: 'user',
                content: issueContext
            };
            messages.push(userMessage);

            // Retry logic
            let retryCount = 0;
            let lastError;

            while (retryCount <= this.maxRetries) {
                try {
                    logger.info(`Calling OpenAI API (attemp ${retryCount + 1}/${this.maxRetries + 1})`);
                    const response = await this.client.chat.completions.create({
                        model: this.model,
                        messages,
                        max_completion_tokens: this.maxCompletionTokens,
                        temperature: 0.7
                    });

                    const content = response.choices[0]?.message?.content;
                    if (!content) {
                        throw new Error('Empty response from OpenAI');
                    }

                    logger.info(`OpenAI generation successfully (${response.usage?.total_tokens || 0})`);

                    // Calculate cost based on model pricing
                    const usage = response.usage || {};
                    const tokenUsage = {
                        promptTokens: usage.prompt_tokens || 0,
                        completionTokens: usage.completion_tokens || 0,
                        totalTokens: usage.total_tokens || 0
                    };

                    // Calculate cost (gpt-4o-mini pricing: $0.15/1M input, $0.60/1M output)
                    const inputCost = (tokenUsage.promptTokens / 1000000) * 0.15;
                    const outputCost = (tokenUsage.completionTokens / 1000000) * 0.60;
                    const totalCost = inputCost + outputCost;

                    // Success - return result
                    return { content, tokenUsage, cost: totalCost };

                } catch (error) {
                    lastError = error;
                    retryCount++;

                    if (retryCount <= this.maxRetries) {
                        const waitTime = Math.pow(2, retryCount) * 1000; // Exponential backoff
                        logger.warn(`OpenAI API error (attempt ${retryCount}): ${error.message}. Retrying in ${waitTime}ms...`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    } else {
                        logger.error(`OpenAI API failed after ${this.maxRetries + 1} attempts: ${error.message}`);
                        throw error;
                    }
                }
            }

        } catch (error) {
            logger.error(`Failed to generate test cases: ${error.message}`);
            throw error;
        }
    }
}