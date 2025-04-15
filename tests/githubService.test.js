// tests/githubService.test.js
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// --- Define mock functions for Octokit METHODS ---
// These are the functions we expect to be called on the Octokit instance
const mockGetLatestRelease = jest.fn();
const mockPullsGet = jest.fn();
const mockIssuesListComments = jest.fn();
const mockPullsListFiles = jest.fn();
const mockIssuesGet = jest.fn(); // Added for refactored getGithubIssueDetails

// --- Create a Mock Octokit INSTANCE Object ---
// This object simulates the structure of a real Octokit instance
// and holds our mock methods. It gets passed to the service functions.
const mockOctokitInstance = {
    repos: {
        getLatestRelease: mockGetLatestRelease
    },
    pulls: {
        get: mockPullsGet,
        listFiles: mockPullsListFiles
    },
    issues: {
        get: mockIssuesGet, // Added
        listComments: mockIssuesListComments
    }
    // Add other methods here if your service functions use them
};

// Mock config - Still needed for callGithubApi (and potentially GITHUB_OWNER default)
jest.mock('../src/config.js', () => ({
    __esModule: true,
    githubToken: 'test-token', // Needed by callGithubApi
    GITHUB_OWNER: 'test-owner' // Needed by getGithubIssueDetails default
}));

// --- REMOVED Octokit Mock ---
// No longer need to mock the constructor, as the service doesn't create the instance.
// jest.mock('@octokit/rest', () => { ... });

// --- Import the service AFTER mocks are defined ---
import * as githubService from '../src/githubService.js';

// NOTE: Tests for callGithubApi omitted for brevity, but would remain similar,
//       testing fetch/API logic rather than Octokit instance calls.
// NOTE: Tests for getGithubIssueDetails would need updating for the new mocks.

describe('GitHub Service (Dependency Injection)', () => {

    beforeEach(() => {
        // Reset ALL method mocks before each test
        mockGetLatestRelease.mockReset();
        mockPullsGet.mockReset();
        mockIssuesListComments.mockReset();
        mockPullsListFiles.mockReset();
        mockIssuesGet.mockReset(); // Added
    });

    // --- Tests for getLatestRelease ---
    describe('getLatestRelease', () => {
        test('should return release info on success', async () => {
            const mockData = { tag_name: 'v1.0.0', published_at: '2024-01-01T00:00:00Z', html_url: 'http://example.com' };
            mockGetLatestRelease.mockResolvedValueOnce({ data: mockData });

            // Pass the mock instance here
            const result = await githubService.getLatestRelease(mockOctokitInstance, 'owner', 'repo');

            expect(result).toEqual({ tagName: 'v1.0.0', publishedAt: '2024-01-01T00:00:00Z', url: 'http://example.com' });
            expect(mockGetLatestRelease).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo' });
            expect(mockGetLatestRelease).toHaveBeenCalledTimes(1);
        });

        test('should return null if Octokit throws 404', async () => {
            const error = new Error('Not Found');
            error.status = 404;
            mockGetLatestRelease.mockRejectedValueOnce(error);

            // Pass the mock instance here
            const result = await githubService.getLatestRelease(mockOctokitInstance, 'owner', 'repo');

            expect(result).toBeNull();
            expect(mockGetLatestRelease).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo' });
            expect(mockGetLatestRelease).toHaveBeenCalledTimes(1);
        });

        test('should return null if Octokit throws other error', async () => {
            const error = new Error('Server Error');
            error.status = 500;
            mockGetLatestRelease.mockRejectedValueOnce(error);

            // Pass the mock instance here
            const result = await githubService.getLatestRelease(mockOctokitInstance, 'owner', 'repo');

            expect(result).toBeNull();
            expect(mockGetLatestRelease).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo' });
            expect(mockGetLatestRelease).toHaveBeenCalledTimes(1);
        });

        test('should return null if owner or repo is missing', async () => {
            // Pass the mock instance here (it won't be used, but required by signature)
            const result1 = await githubService.getLatestRelease(mockOctokitInstance, null, 'repo');
            const result2 = await githubService.getLatestRelease(mockOctokitInstance, 'owner', null);

            expect(result1).toBeNull();
            expect(result2).toBeNull();
            expect(mockGetLatestRelease).not.toHaveBeenCalled();
        });

         test('should return null if invalid octokitInstance provided', async () => {
            const result1 = await githubService.getLatestRelease(null, 'owner', 'repo');
            const result2 = await githubService.getLatestRelease({}, 'owner', 'repo'); // Empty object is invalid

            expect(result1).toBeNull();
            expect(result2).toBeNull();
            expect(mockGetLatestRelease).not.toHaveBeenCalled();
        });
    });

    // --- Tests for getPrDetailsForReview ---
    describe('getPrDetailsForReview', () => {
         test('should return PR details on success', async () => {
            const prData = { number: 1, title: 'PR Title', body: 'PR Body' };
            const commentsData = [{ id: 1, body: 'Comment' }];
            const filesData = [{ filename: 'file.js', patch: 'diff' }];

            mockPullsGet.mockResolvedValueOnce({ data: prData });
            mockIssuesListComments.mockResolvedValueOnce({ data: commentsData });
            mockPullsListFiles.mockResolvedValueOnce({ data: filesData });

            // Pass the mock instance here
            const result = await githubService.getPrDetailsForReview(mockOctokitInstance, 'owner', 'repo', 1);

            expect(result).toEqual({
                title: 'PR Title',
                body: 'PR Body',
                comments: commentsData,
                files: filesData
            });
            expect(mockPullsGet).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', pull_number: 1 });
            expect(mockIssuesListComments).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', issue_number: 1 });
            expect(mockPullsListFiles).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', pull_number: 1 });
            expect(mockPullsGet).toHaveBeenCalledTimes(1);
            // Add more checks if needed
        });

        test('should return null if owner, repo, or prNumber missing', async () => {
             // Pass the mock instance here
            const r1 = await githubService.getPrDetailsForReview(mockOctokitInstance, null, 'repo', 1);
            const r2 = await githubService.getPrDetailsForReview(mockOctokitInstance, 'owner', null, 1);
            const r3 = await githubService.getPrDetailsForReview(mockOctokitInstance, 'owner', 'repo', null);
            expect(r1).toBeNull();
            expect(r2).toBeNull();
            expect(r3).toBeNull();
            expect(mockPullsGet).not.toHaveBeenCalled();
            // Add more checks if needed
        });

        test('should return null if octokit pulls.get fails', async () => {
             const error = new Error('Not Found');
             error.status = 404;
             mockPullsGet.mockRejectedValueOnce(error);

             // Pass the mock instance here
             const result = await githubService.getPrDetailsForReview(mockOctokitInstance, 'owner', 'repo', 1);

             expect(result).toBeNull();
             expect(mockPullsGet).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', pull_number: 1 });
             expect(mockIssuesListComments).not.toHaveBeenCalled(); // Should not be called if pulls.get fails
             expect(mockPullsListFiles).not.toHaveBeenCalled();
             expect(mockPullsGet).toHaveBeenCalledTimes(1);
        });

         test('should return null if invalid octokitInstance provided', async () => {
            const result = await githubService.getPrDetailsForReview(null, 'owner', 'repo', 1);
            expect(result).toBeNull();
            expect(mockPullsGet).not.toHaveBeenCalled();
        });
    });

    // --- Add updated tests for getGithubIssueDetails ---
    describe('getGithubIssueDetails', () => {
        const issueData = { number: 123, title: 'Issue Title', body: 'Issue Body', html_url: 'http://issue.com' };
        const commentsData = [{ id: 1, user: { login: 'user1' }, body: 'Comment 1' }];
        const owner = 'gravityforms'; // Default in function
        const repo = 'backlog'; // Default in function

        test('should return issue details and comments on success', async () => {
            mockIssuesGet.mockResolvedValueOnce({ data: issueData });
            mockIssuesListComments.mockResolvedValueOnce({ data: commentsData });

            // Pass mock instance, only need issue number
            const result = await githubService.getGithubIssueDetails(mockOctokitInstance, 123);

            expect(result).toEqual({
                title: 'Issue Title',
                body: 'Issue Body',
                url: 'http://issue.com',
                comments: [{ user: 'user1', body: 'Comment 1' }]
            });
            expect(mockIssuesGet).toHaveBeenCalledWith({ owner, repo, issue_number: 123 });
            expect(mockIssuesListComments).toHaveBeenCalledWith({ owner, repo, issue_number: 123 });
            expect(mockIssuesGet).toHaveBeenCalledTimes(1);
            expect(mockIssuesListComments).toHaveBeenCalledTimes(1);
        });

        test('should return details even if comments fetch fails', async () => {
            const commentsError = new Error('Failed to get comments');
            commentsError.status = 500;
            mockIssuesGet.mockResolvedValueOnce({ data: issueData });
            mockIssuesListComments.mockRejectedValueOnce(commentsError);

            const result = await githubService.getGithubIssueDetails(mockOctokitInstance, 123);

            expect(result).toEqual({
                title: 'Issue Title',
                body: 'Issue Body',
                url: 'http://issue.com',
                comments: [] // Expect empty comments array
            });
            expect(mockIssuesGet).toHaveBeenCalledWith({ owner, repo, issue_number: 123 });
            expect(mockIssuesListComments).toHaveBeenCalledWith({ owner, repo, issue_number: 123 });
            expect(mockIssuesGet).toHaveBeenCalledTimes(1);
            expect(mockIssuesListComments).toHaveBeenCalledTimes(1);
        });

         test('should return null if octokit issues.get fails', async () => {
            const error = new Error('Not Found');
            error.status = 404;
            mockIssuesGet.mockRejectedValueOnce(error);

            const result = await githubService.getGithubIssueDetails(mockOctokitInstance, 123);

            expect(result).toBeNull();
            expect(mockIssuesGet).toHaveBeenCalledWith({ owner, repo, issue_number: 123 });
            expect(mockIssuesListComments).not.toHaveBeenCalled(); // Comments not fetched if issue get fails
            expect(mockIssuesGet).toHaveBeenCalledTimes(1);
        });

        // Add tests for invalid input, invalid instance etc.
    });


});
