import { Router } from 'express';
import JiraService from '../services/jiraService.js';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import OpenAIService from '../services/openAIService.js';
import { extractProject, findOrCreateProject } from '../utils/projectUtils.js';
import Generation from '../models/Generation.js';


const router = Router();

let jiraService = null;
let openAiService = null;

export function getJiraService() {
    if (!jiraService) {
        try {
            jiraService = new JiraService();
        } catch (e) {
            throw new Error(e.message);
        }
    }

    return jiraService;

}

export function getOpenAIService() {
    if (!openAiService) {
        try {
            openAiService = new OpenAIService();
        } catch (e) {
            throw new Error('email and apiToken are required on environment');
        }
    }

    return openAiService;

}

router.post('/preflight', requireAuth, async (req, res, next) => {

    const { issueKey } = req.body;
    if (!issueKey) {
        return res.status(400).json({ success: false, error: 'issueKey required' });
    }
    // Fetch issue from JIRA
    const jira = getJiraService();
    const issueResult = await jira.getIssue(issueKey);

    if (!issueResult.success) {
        // Return appropriate status code based on error type
        const statusCode = issueResult.error.includes('authentication') || issueResult.error.includes('forbidden')
            ? 401
            : issueResult.error.includes('not found')
                ? 404
                : 500;
        return res.status(statusCode).json({ success: false, error: issueResult.error || 'Issue not found in JIRA' });
    }
    const issue = issueResult.issue;
    const fields = issue.fields;
    const summary = fields.summary || '';
    const description = jira.extractTextFromADF(fields.description) || '';

    // Count attachments
    const attachment = fields.attachment || [];
    const imageAttachments = attachment.filter(att => att.mimeType?.startWiths('image/'));

    // Estimate tokens
    const contextText = `${summary} ${description}`;
    const contextCharacter = contextText.length;
    const estimatedTokens = Math.ceil(contextCharacter / 4) + (imageAttachments.length * 200); // ~200 tokens per image

    // Estimate cost (gpt-4o-mini pricing: $0.15/1M input tokens, $0.60/1M output tokens)
    const estimatedCost = (estimatedTokens / 1000000) * 0.15 + (8000 / 1000000) * 0.60; // Assume ~8k output tokens

    logger.info({
        isUiStory: true,
        issueKey,
        title: summary || 'N/A',
        description,
        attachments: attachment.length,
        estimatedTokens,
        estimatedCost: estimatedCost.toFixed(6)
    })

    // Return preflight data
    return res.json({
        isUiStory: true,
        issueKey,
        title: summary || 'N/A',
        description,
        attachments: attachment.length,
        estimatedTokens,
        estimatedCost: estimatedCost.toFixed(5)
    });
})

// Get all generations (user's own + published ones)
router.get('/', requireAuth, async (req, res, next) => {
    try {
        // Parse pagination parameters
        const page = Math.max(1, parseInt(req.query.page || '1', 10));
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));
        const skip = (page - 1) * limit;

        // Parse filter type: 'all', 'mine', 'published'
        const filterType = req.query.filter || 'all';

        let filter = {};

        if (filterType === 'mine') {
            // Only user's own generations
            filter = { email: req.user.email };
        } else if (filterType === 'published') {
            // Only published generations
            filter = { published: true, status: 'completed' };
        } else {
            // Default: user's own OR published ones from all users
            filter = {
                $or: [
                    { email: req.user.email },
                    { published: true, status: 'completed' }
                ]
            };
        }

        // Fetch generations with pagination
        const [generations, total] = await Promise.all([
            Generation.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit),
            Generation.countDocuments(filter)
        ]);

        // Calculate total pages
        const pages = Math.ceil(total / limit);

        return res.json({
            success: true,
            data: {
                generations,
                pagination: {
                    page,
                    limit,
                    total,
                    pages
                }
            }
        });
    } catch (e) {
        next(e);
    }
});

router.post('/testcases', requireAuth, async (req, res, next) => {
    try {
        const { issueKey } = req.body || {};
        if (!issueKey) {
            return res.status(400).json({ success: false, error: 'issueKey required' });
        }

        // Extract project key and find/create project
        const projectKey = extractProject(issueKey);
        let project = null;

        if (projectKey) {
            try {
                project = await findOrCreateProject(projectKey, req.user.email);
                logger.info(`Associated generation with project: ${projectKey}`);
            } catch (projectError) {
                logger.warn(`Failed to find/create project ${projectKey}: ${projectError.message}. Continuing without project.`);
            }
        }

        // Create generation document
        const generation = new Generation({
            issueKey,
            email: req.user.email,
            project: project ? project._id : undefined,
            mode: 'manual',
            startedAt: new Date()
        });
        await generation.save();

        if (project) {
            const Project = (await import('../models/Project.js')).default;
            const updatedProject = await Project.findById(project._id);
            if (updatedProject) {
                updatedProject.totalGenerations = await Generation.countDocuments({ project: project._id });
                await updatedProject.save();
            }
        }

        // Sync: Fetch JIRA data and generate
        const startTime = Date.now();

        // Fetch issue from JIRA
        const jira = getJiraService();
        const issueResult = await jira.getIssue(issueKey);

        if (!issueResult.success) {
            generation.status = 'failed';
            generation.error = issueResult.error || 'Failed to fetch JIRA issue';
            generation.completedAt = new Date();
            await generation.save();
            return res.status(404).json({ success: false, error: issueResult.error });
        }

        const issue = issueResult.issue;
        const fields = issue.fields;

        // Build context from JIRA issue data
        const summary = fields.summary || '';
        const description = jira.extractTextFromADF(fields.description) || '';

        // Build context string
        const context = `Title: ${summary} Description:${description}`;

        // Generate test cases using OpenAI
        let markdownContent;
        let tokenUsage = null;
        let cost = null;

        try {
            const openai = getOpenAIService();

            logger.info(`Generating test cases with OpenAI (mode: manual)`);
            const result = await openai.generateTestCase(context, issueKey);

            // Handle response format
            if (typeof result === 'string') {
                markdownContent = result;
            } else {
                markdownContent = result.content;
                tokenUsage = result.tokenUsage;
                cost = result.cost;
            }

            // Ensure we have a proper title
            if (!markdownContent.startsWith('#')) {
                markdownContent = `# Test Cases for ${issueKey}: ${summary || 'Untitled'}\n\n${markdownContent}`;
            }
        } catch (error) {
            logger.error(`OpenAI generation failed: ${error.message}`);
            generation.status = 'failed';
            generation.error = `OpenAI generation failed: ${error.message}`;
            generation.completedAt = new Date();
            await generation.save();
            return res.status(500).json({ success: false, error: error.message || 'Failed to generate test cases' });
        }

        // Calculate generation time
        const generationTimeSeconds = (Date.now() - startTime) / 1000;

        // Update generation document
        generation.status = 'completed';
        generation.completedAt = new Date();
        generation.generationTimeSeconds = Math.round(generationTimeSeconds * 100) / 100;
        generation.cost = cost;
        generation.tokenUsage = tokenUsage;
        generation.result = {
            markdown: {
                filename: `${issueKey}_testcases_${generation._id}.md`,
                content: markdownContent
            }
        };
        generation.currentVersion = 1;
        generation.version = [];

        await generation.save();

        logger.info({
            success: true,
            data: {
                generationId: String(generation._id),
                issueKey,
                markdown: generation.result.markdown,
                generationTimeSeconds: generation.generationTimeSeconds,
                cost: generation.cost
            }
        });
        // Return success response
        return res.json({
            success: true,
            data: {
                generationId: String(generation._id),
                issueKey,
                markdown: generation.result.markdown,
                generationTimeSeconds: generation.generationTimeSeconds,
                cost: generation.cost
            }
        });
    }
    catch (e) {
        next(e);
    }
})

router.get('/:id/view', requireAuth, async (req, res, next) => {
    try {
        const gen = await Generation.findById(req.params.id);
        if (!gen) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        // Check if user has permission to view
        // Allow if it's user's own OR if it's published and completed
        const isOwner = gen.email === req.user.email;
        const isPublishedAndCompleted = gen.published && gen.status === 'completed';

        if (!isOwner && !isPublishedAndCompleted) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        // Get latest version info
        const latestVersion = gen.version && gen.version.length > 0
            ? gen.version[gen.version.length - 1]
            : null;

        // Extract project key from issue key (e.g., "KAN-123" -> "KAN")
        const projectKey = gen.issueKey ? extractProject(gen.issueKey) : null;

        return res.json({
            success: true,
            data: {
                email: gen.email,
                content: gen.result?.markdown?.content || '',
                filename: gen.result?.markdown?.filename || 'output.md',
                format: 'markdown',
                // Metadata for header
                issueKey: gen.issueKey,
                projectKey: projectKey,
                updatedAt: gen.updatedAt,
                published: gen.published || false,
                publishedAt: gen.publishedAt,
                publishedBy: gen.publishedBy,
                currentVersion: gen.currentVersion || 1,
                version: gen.version || [],
                lastUpdatedBy: latestVersion?.updatedBy || gen.email,
                lastUpdatedAt: latestVersion?.updatedAt || gen.updatedAt || gen.createdAt
            }
        });
    } catch (e) { next(e); }
})

router.put('/:id/content', requireAuth, async (req, res, next) => {
    try {
        const { content } = req.body;
        if (typeof content !== 'string') {
            return res.status(400).json({ success: false, error: 'content must be a string' });
        }

        // Creator can edit, another user is not allow
        const gen = await Generation.findById(req.params.id);
        if (!gen || gen.email !== req.user.email) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        if (gen.status !== 'completed') {
            return res.status(400).json({ success: false, error: 'Can only update completed generations' });
        }

        // Track version: save current content as a version before updating
        const currentContent = gen.result?.markdown?.content || '';
        if (currentContent && currentContent !== content) {
            // Initialize versions array if needed
            if (!gen.version) gen.version = [];

            // Get the current version number (defaults to 1 if not set)
            const currentVersionNum = gen.currentVersion || 1;

            // Save the current content as a version (only if we haven't already saved this version)
            const versionExists = gen.version.some(v => v.version === currentVersionNum);
            if (!versionExists) {
                gen.version.push({
                    version: currentVersionNum,
                    content: currentContent,
                    updatedAt: new Date(),
                    updatedBy: req.user.email
                });
                logger.info(`Saved version ${currentVersionNum} to versions array for generation ${req.params.id}`);
            }

            // Increment version for the new content
            gen.currentVersion = currentVersionNum + 1;

            logger.info(`Updating generation ${req.params.id} to version ${gen.currentVersion}`);
        }

        // Update the markdown content
        if (!gen.result) gen.result = {};
        if (!gen.result.markdown) gen.result.markdown = {};
        gen.result.markdown.content = content;

        await gen.save();

        return res.json({
            success: true,
            data: {
                content: gen.result.markdown.content,
                currentVersion: gen.currentVersion || 1
            }
        });

    } catch (e) {
        next(e);
    }
})

// Publish/Unpublish generation
router.put('/:id/publish', requireAuth, async (req, res, next) => {
    try {
        const { published } = req.body;
        if (typeof published !== 'boolean') {
            return res.status(400).json({ success: false, error: 'Published must be a boolean' });
        }

        const gen = await Generation.findById(req.params.id);
        if (!gen || gen.email !== req.user.email) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        if (gen.status !== 'completed') {
            return res.status(400).json({ success: false, error: 'Can only publish completed generations' });
        }

        gen.published = published;
        if (published) {
            gen.publishedAt = new Date();
            gen.publishedBy = req.user.email;
            logger.info(`Generation ${req.params.id} published by ${req.user.email}`);
        } else {
            gen.publishedAt = undefined;
            gen.publishedBy = undefined;
            logger.info(`Generation ${req.params.id} unpublished by ${req.user.email}`);
        }

        await gen.save();

        return res.json({
            success: true,
            data: {
                published: gen.published,
                publishedAt: gen.publishedAt,
                publishedBy: gen.publishedBy
            }
        });
    } catch (e) {
        next(e);
    }
});

// Download (allow downloading if it's user's own or published)
router.get('/:id/download', requireAuth, async (req, res, next) => {
    try {
        const gen = await Generation.findById(req.params.id);
        if (!gen) return res.status(404).json({ success: false, error: 'Not found' });

        // Check if user has permission to download
        // Allow if it's user's own OR if it's published and completed
        const isOwner = gen.email === req.user.email;
        const isPublishedAndCompleted = gen.published && gen.status === 'completed';

        if (!isOwner && !isPublishedAndCompleted) {
            return res.status(404).json({ success: false, error: 'Not found' });
        }

        if (gen.status !== 'completed') {
            return res.status(400).json({ success: false, error: 'Not completed' });
        }

        // Set headers for file download
        res.setHeader('Content-Type', 'text/markdown');
        res.setHeader('Content-Disposition', `attachment; filename="${gen.result?.markdown?.filename || 'output.md'}"`);

        // Send the markdown content
        return res.send(gen.result?.markdown?.content || '');
    } catch (e) {
        next(e);
    }
});

// Delete generation (only owner can delete)
router.delete('/:id', requireAuth, async (req, res, next) => {
    try {
        const gen = await Generation.findById(req.params.id);
        if (!gen) {
            return res.status(404).json({ success: false, error: 'Generation not found' });
        }

        // Only the owner can delete their generation
        if (gen.email !== req.user.email) {
            return res.status(403).json({ success: false, error: 'You can only delete your own generations' });
        }

        // Check if it's published - warn but allow deletion
        if (gen.published) {
            logger.warn(`User ${req.user.email} is deleting published generation ${req.params.id}`);
        }

        // Delete the generation
        await Generation.findByIdAndDelete(req.params.id);

        logger.info(`Generation ${req.params.id} deleted by ${req.user.email}`);
        return res.json({ success: true, message: 'Generation deleted successfully' });
    } catch (e) {
        next(e);
    }
});

export default router;