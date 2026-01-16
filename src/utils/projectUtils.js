export function extractProject(issueKey) {
    if (!issueKey || typeof issueKey !== 'string') {
        return null;
    }

    // Match pattern : SDET
    const match = issueKey.match(/^([A-Z0-9]+)-/i);
    return match ? match[1].toUpperCase() : null;
}

export async function findOrCreateProject(projectKey, userEmail) {
    const Project = (await import('../models/Project.js')).default;
    if (!projectKey) {
        throw new Error('Project Key is required!');
    }

    // Normolize to uppercase
    const normalizeKey = projectKey.toUpperCase();

    // Find if there is existing one
    let project = await Project.findOne({ projectKey: normalizeKey });

    // Create and save if no existing one
    if (!project) {
        project = new Project({
            projectKey: normalizeKey,
            createdBy: userEmail,
            firstGeneratedAt: new Date(),
            lastGeneratedAt: new Date,
            totalGenerations: 0
        });
        await project.save();
    } else {
        project.lastGeneratedAt = new Date();
        await project.save();
    }
    return project;
}