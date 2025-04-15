// src/githubService.js

// Note: Octokit is no longer imported or used directly here for most functions.
// It will be passed in.
import fetch from 'node-fetch';
import {
    githubToken, // Still needed for callGithubApi and potentially others not using octokitInstance
    GITHUB_OWNER // May still be needed if hardcoded owners are used
} from './config.js';

// No more internal octokit instance or init function
// let octokit = null;
// function initOctokit() { ... }
// initOctokit(); // Removed

// --- Functions modified to accept octokitInstance ---

/**
 * Fetches the latest release for a given repository using the provided Octokit instance.
 * @param {import('@octokit/rest').Octokit} octokitInstance - An initialized Octokit instance.
 * @param {string} owner - The repository owner.
 * @param {string} repo - The repository name.
 * @returns {Promise<object | null>} Object with tagName, publishedAt, url, or null.
 */
async function getLatestRelease(octokitInstance, owner, repo) {
    // Check if a valid Octokit instance was passed
    if (!octokitInstance || typeof octokitInstance.repos?.getLatestRelease !== 'function') {
        console.error("[GitHub Service] getLatestRelease called without a valid Octokit instance.");
        return null;
    }
    if (!owner || !repo) {
        console.error("[GitHub Service] getLatestRelease requires owner and repo.");
        return null;
    }
    try {
        console.log(`[GitHub Service] Fetching latest release for ${owner}/${repo}`);
        // Use the passed-in instance
        const { data } = await octokitInstance.repos.getLatestRelease({ owner, repo });
        return {
            tagName: data.tag_name,
            publishedAt: data.published_at,
            url: data.html_url
        };
    } catch (error) {
        if (error.status === 404) {
            console.log(`[GitHub Service] No releases found for ${owner}/${repo} (404).`);
        } else {
            console.error(`[GitHub Service] Error fetching latest release for ${owner}/${repo}:`, error.status, error.message);
        }
        return null;
    }
}

/**
 * Fetches details for a specific issue using the provided Octokit instance.
 * @param {import('@octokit/rest').Octokit} octokitInstance - An initialized Octokit instance.
 * @param {number} issueNumber - The number of the issue to fetch.
 * @param {string} [owner=GITHUB_OWNER] - The repository owner (defaults to GITHUB_OWNER from config).
 * @param {string} [repo='backlog'] - The repository name (defaults to 'backlog').
 * @returns {Promise<object|null>} - An object containing issue details (title, body, url, comments) or null if not found or error.
 */
async function getGithubIssueDetails(octokitInstance, issueNumber, owner = GITHUB_OWNER, repo = 'backlog') {
    if (!octokitInstance || typeof octokitInstance.issues?.get !== 'function' || typeof octokitInstance.issues?.listComments !== 'function') {
        console.error("[GitHub Service] getGithubIssueDetails called without a valid Octokit instance.");
        return null;
    }
     if (!issueNumber || typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || issueNumber <= 0) {
         console.error("[GitHub Service] Invalid issue number provided:", issueNumber);
         return null;
     }
     if (!owner || !repo) {
        console.error("[GitHub Service] getGithubIssueDetails requires owner and repo.");
        return null;
    }

    try {
        console.log(`[GitHub Service] Fetching issue details for ${owner}/${repo}#${issueNumber}`);
        // Fetch main issue details using Octokit
        const { data: issueData } = await octokitInstance.issues.get({
            owner,
            repo,
            issue_number: issueNumber,
        });

        console.log(`[GitHub Service] Fetching comments for ${owner}/${repo}#${issueNumber}`);
        // Fetch issue comments using Octokit
        let commentsData = [];
        try {
            const { data: rawComments } = await octokitInstance.issues.listComments({
                owner,
                repo,
                issue_number: issueNumber,
            });
            // Ensure it's an array before assigning
            if (Array.isArray(rawComments)) {
                commentsData = rawComments;
            } else {
                console.warn(`[GitHub Service] Comments response for issue ${issueNumber} was not an array.`);
            }
        } catch (commentError) {
             // Log error but don't fail the whole process if comments fail
            console.warn(`[GitHub Service] Failed to fetch comments for issue ${issueNumber}. Status: ${commentError.status} ${commentError.message}`);
        }

        // Limit number of comments to keep context manageable (e.g., last 10)
        const MAX_COMMENTS = 10;
        const relevantComments = commentsData.slice(-MAX_COMMENTS);

        return {
            title: issueData?.title || 'N/A',
            body: issueData?.body || '',
            url: issueData?.html_url || `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
            comments: relevantComments.map(comment => ({
                user: comment?.user?.login || 'unknown',
                body: comment?.body || ''
            })) || []
        };

    } catch (error) {
        console.error(`[GitHub Service] Error fetching details for ${owner}/${repo}#${issueNumber}:`, error.status, error.message);
         if (error.status === 404) {
             console.log(`[GitHub Service] Issue ${owner}/${repo}#${issueNumber} not found (404).`);
         }
        return null;
    }
}

/**
 * Calls the GitHub API using fetch based on details provided. Requires githubToken in config.
 * @param {object} apiDetails - Object containing endpoint, method, parameters, headers.
 * @returns {Promise<object>} - The JSON response from the GitHub API.
 */
async function callGithubApi(apiDetails) {
    // This function remains largely unchanged as it uses fetch directly
    // It still relies on githubToken from config
    const { endpoint, method = 'GET', parameters = {}, headers = {} } = apiDetails;

    if (!githubToken) {
        console.warn("[GitHub Service] GITHUB_TOKEN is not set. Cannot call GitHub API via callGithubApi.");
        throw new Error('GitHub token is missing. Cannot call API.');
    }
    // ... (rest of the fetch logic remains the same as your original file) ...
     if (!endpoint) {
         throw new Error('GitHub API endpoint is missing in the details.');
     }
     const url = new URL(endpoint);
     const requestHeaders = {
         'Accept': 'application/vnd.github.v3+json',
         'Authorization': `token ${githubToken}`,
         'Content-Type': 'application/json',
         ...headers
     };
     const options = {
         method: method.toUpperCase(),
         headers: requestHeaders,
     };
     if (method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
         options.body = JSON.stringify(parameters);
     } else {
         Object.keys(parameters).forEach(key => url.searchParams.append(key, parameters[key]));
     }
     console.log(`[GitHub Service] Making request: ${options.method} ${url.toString()}`);
     if (options.body) console.log(`[GitHub Service] Body:`, options.body);
     try {
         const response = await fetch(url.toString(), options);
         if (!response.ok) {
             const errorBody = await response.text();
             console.error(`[GitHub Service] API Error: ${response.status} ${response.statusText}`, errorBody);
             throw new Error(`GitHub API request failed with status ${response.status}: ${errorBody}`);
         }
         const contentType = response.headers.get('content-type');
         if (contentType && contentType.includes('application/json')) {
             const jsonResponse = await response.json();
             console.log('[GitHub Service] API Success. Received JSON response.');
             return jsonResponse;
         } else {
             console.log(`[GitHub Service] API Success. Received non-JSON response (Status: ${response.status}).`);
             return { status: response.status, statusText: response.statusText };
         }
     } catch (error) {
         console.error('[GitHub Service] Network or fetch error:', error);
         throw new Error(`Failed to call GitHub API: ${error.message}`);
     }
}

/**
 * Fetches details needed for reviewing a Pull Request using the provided Octokit instance.
 * @param {import('@octokit/rest').Octokit} octokitInstance - An initialized Octokit instance.
 * @param {string} owner The repository owner.
 * @param {string} repo The repository name.
 * @param {number} prNumber The pull request number.
 * @returns {Promise<object|null>} Object with title, body, comments, files, or null on error.
 */
async function getPrDetailsForReview(octokitInstance, owner, repo, prNumber) {
    if (!octokitInstance || typeof octokitInstance.pulls?.get !== 'function' || typeof octokitInstance.issues?.listComments !== 'function' || typeof octokitInstance.pulls?.listFiles !== 'function') {
        console.error("[GitHub Service] getPrDetailsForReview called without a valid Octokit instance.");
        return null;
    }
    if (!owner || !repo || !prNumber) {
        console.error("[GitHub Service] getPrDetailsForReview requires owner, repo, and prNumber.");
        return null;
    }

    try {
        console.log(`[GitHub Service] Fetching details for PR ${owner}/${repo}#${prNumber}`);

        // Use the passed-in instance
        const { data: pr } = await octokitInstance.pulls.get({ owner, repo, pull_number: prNumber });
        const { data: comments } = await octokitInstance.issues.listComments({ owner, repo, issue_number: prNumber });
        const { data: files } = await octokitInstance.pulls.listFiles({ owner, repo, pull_number: prNumber });

        console.log(`[GitHub Service] Fetched PR details, ${comments.length} comments, ${files.length} files.`);
        return {
            title: pr.title,
            body: pr.body,
            comments: comments,
            files: files
        };
    } catch (error) {
        console.error(`[GitHub Service] Error fetching details for PR ${owner}/${repo}#${prNumber}:`, error.status, error.message);
        if (error.status === 404) {
             console.log(`[GitHub Service] PR ${owner}/${repo}#${prNumber} not found (404).`);
        }
        return null;
    }
}

// Export the refactored functions
export { getLatestRelease, getGithubIssueDetails, callGithubApi, getPrDetailsForReview };