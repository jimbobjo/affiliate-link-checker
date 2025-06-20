// Replace the existing checkSingleLink function in your HTML file
async function checkLinks() {
    if (isChecking) return;

    const linksText = document.getElementById('links').value.trim();
    if (!linksText) {
        showMessage('Please enter some links to check!', 'error');
        return;
    }

    const links = linksText.split('\n').filter(link => link.trim());
    if (links.length === 0) {
        showMessage('Please enter valid links!', 'error');
        return;
    }

    if (links.length > 50) {
        showMessage('Free version limited to 50 links. Upgrade to Pro for unlimited checking!', 'error');
        return;
    }

    isChecking = true;
    checkResults = [];
    originalResults = [];

    // Show progress
    document.getElementById('progressSection').classList.add('active');
    document.getElementById('results').classList.add('hidden');

    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const progressCount = document.getElementById('progressCount');

    progressCount.textContent = `0 / ${links.length}`;
    progressBar.style.width = '0%';
    progressText.textContent = 'Initializing link check...';

    // Get options
    const options = {
        followRedirects: document.getElementById('followRedirects').checked,
        checkSSL: document.getElementById('checkSSL').checked,
        checkSpeed: document.getElementById('checkSpeed').checked,
        timeout: parseInt(document.getElementById('timeout').value) * 1000,
        userAgent: document.getElementById('userAgent').value
    };

    try {
        // Call the Netlify serverless function
        const response = await fetch('/.netlify/functions/check-links', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                links: links,
                options: options
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `HTTP ${response.status}`);
        }

        const data = await response.json();
        checkResults = data.results;
        originalResults = [...checkResults];

        // Simulate progress for better UX
        let progress = 0;
        const progressInterval = setInterval(() => {
            progress += 2;
            progressBar.style.width = `${Math.min(progress, 95)}%`;
            progressCount.textContent = `Processing... ${Math.min(Math.floor(progress * links.length / 100), links.length)} / ${links.length}`;
        }, 100);

        // Wait a moment to show progress, then complete
        setTimeout(() => {
            clearInterval(progressInterval);
            progressBar.style.width = '100%';
            progressCount.textContent = `${links.length} / ${links.length}`;
            progressText.textContent = 'Processing complete!';

            // Hide progress, show results
            setTimeout(() => {
                document.getElementById('progressSection').classList.remove('active');
                document.getElementById('results').classList.remove('hidden');
                updateStats();
                displayResults();
                showMessage(`Successfully checked ${links.length} links!`, 'success');
            }, 500);
        }, 1000);

    } catch (error) {
        console.error('Link checking failed:', error);
        document.getElementById('progressSection').classList.remove('active');
        showMessage(`Error checking links: ${error.message}`, 'error');
    } finally {
        isChecking = false;
    }
}

// Update the displayResults function to handle the new data structure
function displayResults() {
    const resultsList = document.getElementById('resultsList');
    resultsList.innerHTML = '';

    checkResults.forEach((result, index) => {
        const item = document.createElement('div');
        
        let statusClass = result.status;
        item.className = `result-item ${statusClass}`;
        
        let redirectHtml = '';
        if (result.redirectChain && result.redirectChain.length > 0) {
            redirectHtml = `
                <div class="redirect-chain">
                    <strong>Redirect Chain:</strong>
                    ${result.redirectChain.map(step => 
                        `<div class="redirect-step">${step.url} → ${step.location} (${step.status})</div>`
                    ).join('')}
                </div>
            `;
        }

        let errorHtml = '';
        if (result.error) {
            errorHtml = `<div class="error-message">Error: ${result.error}</div>`;
        }

        let headerInfo = '';
        if (result.headers && result.headers.server) {
            headerInfo = `<small>Server: ${result.headers.server}</small>`;
        }
        
        item.innerHTML = `
            <div class="result-url">${result.url}</div>
            <div class="result-details">
                <div class="result-info">
                    <span class="status-badge status-${statusClass}">
                        ${result.statusCode} ${result.message}
                    </span>
                    ${result.sslValid !== null ? `<small>SSL: ${result.sslValid ? '✅ Valid' : '❌ Invalid'}</small>` : ''}
                    ${headerInfo}
                </div>
                <div class="result-metrics">
                    <div>${result.responseTime}ms</div>
                    <small>${new Date(result.timestamp).toLocaleTimeString()}</small>
                </div>
            </div>
            ${redirectHtml}
            ${errorHtml}
        `;
        
        resultsList.appendChild(item);
    });
}

// Enhanced error handling for production
function showMessage(message, type) {
    // Remove existing messages
    const existingMessages = document.querySelectorAll('.error-message, .success-message');
    existingMessages.forEach(msg => msg.remove());

    // Create new message
    const messageDiv = document.createElement('div');
    messageDiv.className = type === 'error' ? 'error-message' : 'success-message';
    messageDiv.textContent = message;

    // Add to input section
    const inputSection = document.querySelector('.input-section');
    inputSection.appendChild(messageDiv);

    // Auto-remove after 5 seconds
    setTimeout(() => {
        if (messageDiv.parentNode) {
            messageDiv.remove();
        }
    }, 5000);

    // Track errors for analytics
    if (type === 'error') {
        trackEvent('link_check_error', { message: message });
    }
}