document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('classify-form');
    const textarea = document.getElementById('product-titles');
    const submitBtn = document.getElementById('submit-btn');
    const btnText = submitBtn.querySelector('.btn-text');
    const spinner = submitBtn.querySelector('.spinner');
    
    const resultsPanel = document.getElementById('results-panel');
    const resultsBody = document.getElementById('results-body');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const text = textarea.value.trim();
        if (!text) return;

        // Split by newlines and remove empty lines
        const items = text.split('\n').map(s => s.trim()).filter(s => s.length > 0);
        if (items.length === 0) return;

        // UI Reset
        submitBtn.disabled = true;
        btnText.classList.add('hidden');
        spinner.classList.remove('hidden');
        resultsPanel.classList.remove('hidden');
        resultsBody.innerHTML = '';

        // Initialize rows
        const rows = [];
        items.forEach((item, index) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${escapeHTML(item)}</td>
                <td class="col-refined">-</td>
                <td class="col-hscode">-</td>
                <td class="col-desc">-</td>
                <td class="col-rate">-</td>
                <td class="col-itc">-</td>
                <td class="col-itcdesc">-</td>
                <td class="col-policy">-</td>
                <td class="col-bcd">-</td>
                <td class="col-status"><span class="status-badge status-pending">Pending</span></td>
            `;
            resultsBody.appendChild(tr);
            rows.push(tr);
        });

        // Process sequentially
        for (let i = 0; i < items.length; i++) {
            const row = rows[i];
            const statusCell = row.querySelector('.col-status');
            
            // Mark as processing
            statusCell.innerHTML = '<span class="status-badge status-processing">Processing...</span>';
            row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

            try {
                const response = await fetch('/api/classify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ productTitle: items[i] })
                });

                const data = await response.json();

                if (!response.ok) {
                    // Show the exact error from the server
                    const errMsg = data.details || data.error || `Server error ${response.status}`;
                    throw new Error(errMsg);
                }
                
                // Expecting backend to return parsed data alongside raw result string
                if (data.data) {
                    row.querySelector('.col-refined').textContent = data.data.productName || 'N/A';
                    row.querySelector('.col-hscode').textContent = data.data.hsCode || 'N/A';
                    row.querySelector('.col-desc').textContent = data.data.articleDescription || 'N/A';
                    row.querySelector('.col-rate').textContent = data.data.dutyRate || 'N/A';
                    // India data
                    if (data.data.india) {
                        row.querySelector('.col-itc').textContent = data.data.india.itcCode || 'N/A';
                        row.querySelector('.col-itcdesc').textContent = data.data.india.itcDesc || 'N/A';
                        row.querySelector('.col-policy').textContent = data.data.india.importPolicy || 'N/A';
                        row.querySelector('.col-bcd').textContent = data.data.india.indiaDuty || 'N/A';
                    }
                } else {
                    // Fallback to raw result if structure is missing
                    row.querySelector('.col-desc').textContent = data.result;
                }

                statusCell.innerHTML = '<span class="status-badge status-success">Done</span>';
            } catch (err) {
                statusCell.innerHTML = '<span class="status-badge status-error">Error</span>';
                row.querySelector('.col-desc').textContent = err.message;
            }
        }

        // Restore UI
        submitBtn.disabled = false;
        btnText.classList.remove('hidden');
        spinner.classList.add('hidden');
    });

    function escapeHTML(str) {
        return str.replace(/[&<>'"]/g, 
            tag => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                "'": '&#39;',
                '"': '&quot;'
            }[tag] || tag)
        );
    }

    const downloadBtn = document.getElementById('download-btn');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', () => {
            const rows = Array.from(resultsBody.querySelectorAll('tr'));
            if (rows.length === 0) {
                alert('No results to download yet.');
                return;
            }

            let csvContent = "Original Title,Refined Name,US HS Code,Article Description,US Duty Rate,ITC-HS Code,India Description,Import Policy,India BCD,Status\n";

            rows.forEach(row => {
                const cols = Array.from(row.querySelectorAll('td')).map(td => {
                    let text = td.innerText.replace(/"/g, '""'); // escape quotes
                    return `"${text}"`; // wrap in quotes to handle commas
                });
                csvContent += cols.join(',') + "\n";
            });

            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.setAttribute('href', url);
            link.setAttribute('download', 'hs_code_classifications.csv');
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });
    }
});

// ── Live API Status Checker ──
function checkApiStatus() {
    const statusContainer = document.getElementById('api-status');
    const statusText = statusContainer.querySelector('.status-text');
    
    // Set checking state
    statusContainer.className = 'api-status checking';
    statusText.textContent = 'Checking API Status...';

    fetch('/api/ping')
        .then(response => {
            if (response.ok) {
                statusContainer.className = 'api-status online';
                statusText.textContent = 'API Online';
            } else {
                throw new Error('API returned non-ok status');
            }
        })
        .catch(error => {
            statusContainer.className = 'api-status offline';
            statusText.textContent = 'API Offline';
            console.error('API Status Check Failed:', error);
        });
}

// Check immediately on load, then every 30 seconds
checkApiStatus();
setInterval(checkApiStatus, 30000);
