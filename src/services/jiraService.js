import fetch from 'node-fetch';
import { jiraConfig } from '../config/index.js';
import { logger } from '../utils/logger.js';

class JiraService {
  constructor() {
    if (!jiraConfig.email || !jiraConfig.apiToken) {
      throw new Error('email and apiToken are required on environment');
    }
    //const { email, apiToken, baseUrl } = jiraConfig;
    const credentials = Buffer.from(
      `${jiraConfig.email}:${jiraConfig.apiToken}`
    ).toString('base64');
    this.authHeader = `Basic ${credentials}`;
    this.baseUrl = jiraConfig.baseUrl;
  }

  async getIssue(issueKey) {
    try {
      // Normalize issue key - trim whitespace and convert to uppercase
      const normalizedKey = issueKey.trim().toUpperCase();

      // Validate issue key format (PROJECT-NUMBER, e.g., TES-1, KAN-123)
      if (!/^[A-Z]+-\d+$/.test(normalizedKey)) {
        logger.error(`Invalid issue key format: ${issueKey}`);
        return {
          success: false,
          error: `Invalid issue key format: ${issueKey}. Expected format: PROJECT-NUMBER (e.g., TES-1, KAN-123).`
        };
      }

      const url = `${this.baseUrl}/rest/api/3/issue/${normalizedKey}?expand=attachments,comments,issuelinks`;
      logger.info(`Fetching JIRA issue: ${normalizedKey} from ${this.baseUrl}`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': this.authHeader,
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `JIRA API error: ${response.status}`;
        // Parse JIRA error response
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.errorMessages && errorJson.errorMessages.length > 0) {
            errorMessage = errorJson.errorMessages[0];
          } else if (errorJson.message) {
            errorMessage = errorJson.message;
          }
        } catch {
          errorMessage = errorText || errorMessage;
        }

        logger.error(
          `JIRA API error for ${normalizedKey}: ${response.status} - ${errorMessage}`
        );

        // Provide helpful messages based on status code
        if (response.status === 401) {
          return {
            success: false,
            error:
              'JIRA authentication failed. Please check your JIRA_EMAIL and JIRA_API_TOKEN credentials.',
          };
        } else if (response.status === 403) {
          return {
            success: false,
            error: `JIRA access forbidden for issue ${normalizedKey}.`,
          };
        } else if (response.status === 404) {
          return {
            success: false,
            error: `Issue ${normalizedKey} not found or you don't have permission to view it.`,
          };
        }

        return { success: false, error: errorMessage };
      }

      const issue = await response.json();
      logger.info(`Successfully fetched JIRA issue: ${normalizedKey}`);
      return { success: true, issue };
    } catch (error) {
      logger.error(`Failed to fetch JIRA issue ${issueKey}:`, error);

      // Network/connection errors
      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        return {
          success: false,
          error: `Cannot connect to JIRA at ${this.baseUrl}. Please check JIRA_BASE_URL configuration.`,
        };
      }
      //logger.error(`Failed to fetch JIRA issue ${issueKey}:`, e);
      return { success: false, error: 'aa ${issueKey}: ${error.message}' || 'Failed to fetch issue from JIRA' };
    }
  }

  extractTextFromADF(adf) {
    // Atlassian Document Format text extraction
    // This method is REQUIRED - it converts JIRA's ADF format to plain text
    if (!adf || typeof adf !== 'object') return '';

    if (adf.content && Array.isArray(adf.content)) {
      return adf.content
        .map((node) => {
          if (node.type === 'text' && node.text) {
            return node.text;
          }
          if (node.content) {
            return this.extractTextFromADF(node);
          }
          return '';
        })
        .filter(Boolean)
        .join(' ');
    }

    return '';
  }
}
export default JiraService;
