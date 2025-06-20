// netlify/functions/check-links.js
// Production-ready serverless function for affiliate link validation

const fetch = require('node-fetch');
const https = require('https');

// Rate limiting configuration
const RATE_LIMITS = {
  maxLinksPerRequest: 50,
  timeoutMs: 15000,
  maxConcurrency: 8
};

// Security configuration
const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '10.', '192.168.', '172.'];
const ALLOWED_PROTOCOLS = ['http:', 'https:'];

exports.handler = async (event, context) => {
  // CORS headers for cross-origin requests
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { links, options = {} } = JSON.parse(event.body);

    // Input validation and sanitization
    if (!Array.isArray(links) || links.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid links array' })
      };
    }

    if (links.length > RATE_LIMITS.maxLinksPerRequest) {
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({ 
          error: `Maximum ${RATE_LIMITS.maxLinksPerRequest} links per request`,
          upgrade: 'Contact support for enterprise limits'
        })
      };
    }

    // Sanitize and validate URLs
    const sanitizedLinks = links
      .map(link => sanitizeUrl(link))
      .filter(link => link && validateUrl(link));

    if (sanitizedLinks.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'No valid URLs provided' })
      };
    }

    // Process links with controlled concurrency
    const results = await processLinksWithConcurrency(sanitizedLinks, options);

    // Generate summary statistics
    const summary = generateSummary(results);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        results,
        summary,
        processed: results.length,
        timestamp: new Date().toISOString()
      })
    };

  } catch (error) {
    console.error('Function error:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Processing failed'
      })
    };
  }
};

function sanitizeUrl(url) {
  if (typeof url !== 'string') return null;
  
  url = url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  
  try {
    const urlObj = new URL(url);
    return urlObj.href;
  } catch {
    return null;
  }
}

function validateUrl(url) {
  try {
    const urlObj = new URL(url);
    
    // Protocol validation
    if (!ALLOWED_PROTOCOLS.includes(urlObj.protocol)) {
      return false;
    }
    
    // Security: Block private/local IPs
    const hostname = urlObj.hostname.toLowerCase();
    if (BLOCKED_HOSTS.some(blocked => hostname.includes(blocked))) {
      return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

async function processLinksWithConcurrency(links, options) {
  const results = [];
  const batches = [];
  
  // Create batches for controlled concurrency
  for (let i = 0; i < links.length; i += RATE_LIMITS.maxConcurrency) {
    batches.push(links.slice(i, i + RATE_LIMITS.maxConcurrency));
  }

  for (const batch of batches) {
    const batchPromises = batch.map(url => checkSingleLink(url, options));
    const batchResults = await Promise.allSettled(batchPromises);
    
    batchResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        results.push({
          url: batch[index],
          status: 'error',
          statusCode: 'PROCESSING_ERROR',
          message: 'Failed to process',
          responseTime: 0,
          timestamp: new Date().toISOString(),
          error: result.reason?.message || 'Unknown error'
        });
      }
    });
    
    // Small delay between batches to prevent overwhelming targets
    if (batches.length > 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  return results;
}

async function checkSingleLink(url, options) {
  const startTime = Date.now();
  const timeout = options.timeout || RATE_LIMITS.timeoutMs;
  
  const fetchOptions = {
    method: 'HEAD',
    timeout,
    follow: options.followRedirects !== false ? 10 : 0,
    headers: {
      'User-Agent': getUserAgent(options.userAgent),
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache'
    },
    agent: url.startsWith('https:') ? new https.Agent({
      rejectUnauthorized: options.checkSSL !== false
    }) : undefined
  };

  try {
    const response = await fetch(url, fetchOptions);
    const responseTime = Date.now() - startTime;
    
    // Determine status classification
    let status = 'healthy';
    let message = 'OK';
    
    if (response.status >= 400) {
      status = 'broken';
      message = getStatusMessage(response.status);
    } else if (responseTime > 5000) {
      status = 'warning';
      message = 'Slow Response';
    } else if (response.status >= 300 && response.status < 400) {
      status = 'redirect';
      message = 'Redirect';
    }

    // Collect redirect chain if requested
    let redirectChain = null;
    if (options.followRedirects !== false && response.url !== url) {
      redirectChain = await getRedirectChain(url, options);
    }

    return {
      url,
      status,
      statusCode: response.status,
      message,
      responseTime,
      redirectChain,
      sslValid: url.startsWith('https:') && options.checkSSL !== false ? true : null,
      timestamp: new Date().toISOString(),
      headers: {
        'content-type': response.headers.get('content-type'),
        'server': response.headers.get('server'),
        'last-modified': response.headers.get('last-modified')
      }
    };

  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    let status = 'broken';
    let message = 'Connection Failed';
    
    if (error.code === 'ENOTFOUND') {
      message = 'DNS Resolution Failed';
    } else if (error.code === 'ECONNREFUSED') {
      message = 'Connection Refused';
    } else if (error.code === 'ETIMEDOUT' || error.name === 'FetchError') {
      message = 'Request Timeout';
    } else if (error.code === 'CERT_HAS_EXPIRED') {
      message = 'SSL Certificate Expired';
    }

    return {
      url,
      status,
      statusCode: error.code || 'ERROR',
      message,
      responseTime,
      redirectChain: null,
      sslValid: null,
      timestamp: new Date().toISOString(),
      error: error.message
    };
  }
}

async function getRedirectChain(originalUrl, options) {
  const chain = [];
  let currentUrl = originalUrl;
  let maxRedirects = 5;
  
  try {
    while (maxRedirects > 0) {
      const response = await fetch(currentUrl, {
        method: 'HEAD',
        redirect: 'manual',
        timeout: 5000,
        headers: {
          'User-Agent': getUserAgent(options.userAgent)
        }
      });
      
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          chain.push({
            url: currentUrl,
            status: response.status,
            location: location
          });
          currentUrl = new URL(location, currentUrl).href;
          maxRedirects--;
        } else {
          break;
        }
      } else {
        break;
      }
    }
  } catch (error) {
    // Redirect chain detection failed, return what we have
  }
  
  return chain.length > 0 ? chain : null;
}

function getUserAgent(type) {
  const userAgents = {
    chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    mobile: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
    bot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    default: 'Mozilla/5.0 (compatible; LinkChecker/1.0; +https://tools.allaroundworkers.com)'
  };
  
  return userAgents[type] || userAgents.default;
}

function getStatusMessage(statusCode) {
  const messages = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout'
  };
  
  return messages[statusCode] || `HTTP ${statusCode}`;
}

function generateSummary(results) {
  const summary = {
    total: results.length,
    healthy: 0,
    broken: 0,
    warning: 0,
    redirect: 0,
    averageResponseTime: 0,
    errors: []
  };

  let totalResponseTime = 0;

  results.forEach(result => {
    summary[result.status]++;
    totalResponseTime += result.responseTime;
    
    if (result.error) {
      summary.errors.push({
        url: result.url,
        error: result.error
      });
    }
  });

  summary.averageResponseTime = Math.round(totalResponseTime / results.length);
  
  return summary;
}
