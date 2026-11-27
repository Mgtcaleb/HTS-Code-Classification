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
                <td class="col-actions"><button type="button" class="teach-btn hidden" data-title="${escapeHTML(item)}">✏️ Teach</button></td>
            `;
            resultsBody.appendChild(tr);
            rows.push(tr);
        });

        const progressContainer = document.getElementById('progress-container');
        const progressBarFill = document.getElementById('progress-bar-fill');
        const progressText = document.getElementById('progress-text');
        const progressSpeed = document.getElementById('progress-speed');
        const stopBtn = document.getElementById('stop-btn');

        // Concurrency settings for high throughput (8 concurrent workers for bulk items)
        const CONCURRENCY = 8;
        let isStopped = false;
        let completedCount = 0;
        let successCount = 0;
        let errorCount = 0;
        const totalItems = items.length;
        const startTime = Date.now();

        stopBtn.classList.remove('hidden');
        stopBtn.disabled = false;
        stopBtn.textContent = 'Stop Processing';
        progressContainer.classList.remove('hidden');

        function updateProgress() {
            const pct = totalItems > 0 ? Math.round((completedCount / totalItems) * 100) : 0;
            progressBarFill.style.width = `${pct}%`;
            const elapsedSec = (Date.now() - startTime) / 1000;
            const rate = elapsedSec > 0.5 ? (completedCount / elapsedSec).toFixed(1) : '0';
            progressText.textContent = `Processed: ${completedCount} / ${totalItems} (${pct}%) • Success: ${successCount} • Errors: ${errorCount}`;
            progressSpeed.textContent = `Speed: ${rate} items/sec`;
        }

        updateProgress();

        const stopHandler = () => {
            isStopped = true;
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stopping...';
        };
        stopBtn.onclick = stopHandler;

        async function processItem(i) {
            if (isStopped) return;
            const row = rows[i];
            const statusCell = row.querySelector('.col-status');
            statusCell.innerHTML = '<span class="status-badge status-processing">Processing...</span>';

            // Only auto-scroll on small batches to prevent browser jank on 1000 items
            if (totalItems <= 15) {
                row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }

            try {
                const response = await fetch('/api/classify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ productTitle: items[i] })
                });

                const data = await response.json();

                if (!response.ok) {
                    const errMsg = data.details || data.error || `Server error ${response.status}`;
                    throw new Error(errMsg);
                }
                
                if (data.data) {
                    row.querySelector('.col-refined').textContent = data.data.productName || 'N/A';
                    row.querySelector('.col-hscode').textContent = data.data.hsCode || 'N/A';
                    row.querySelector('.col-desc').textContent = data.data.articleDescription || 'N/A';
                    row.querySelector('.col-rate').textContent = data.data.dutyRate || 'N/A';
                    if (data.data.india) {
                        row.querySelector('.col-itc').textContent = data.data.india.itcCode || 'N/A';
                        row.querySelector('.col-itcdesc').textContent = data.data.india.itcDesc || 'N/A';
                        row.querySelector('.col-policy').textContent = data.data.india.importPolicy || 'N/A';
                        row.querySelector('.col-bcd').textContent = data.data.india.indiaDuty || 'N/A';
                    }
                } else {
                    row.querySelector('.col-desc').textContent = data.result || '';
                }

                statusCell.innerHTML = '<span class="status-badge status-success">Done</span>';
                const teachBtn = row.querySelector('.teach-btn');
                if (teachBtn) teachBtn.classList.remove('hidden');
                successCount++;

            } catch (err) {
                statusCell.innerHTML = '<span class="status-badge status-error">Error</span>';
                row.querySelector('.col-desc').textContent = err.message;
                const teachBtn = row.querySelector('.teach-btn');
                if (teachBtn) teachBtn.classList.remove('hidden');
                errorCount++;
            } finally {
                completedCount++;
                updateProgress();
            }
        }

        // Concurrency Worker Pool
        let nextIndex = 0;
        async function worker() {
            while (nextIndex < totalItems && !isStopped) {
                const i = nextIndex++;
                await processItem(i);
            }
        }

        const workers = [];
        const workerCount = Math.min(CONCURRENCY, totalItems);
        for (let w = 0; w < workerCount; w++) {
            workers.push(worker());
        }
        await Promise.all(workers);

        stopBtn.classList.add('hidden');
        stopBtn.onclick = null;

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
function updateIndicator(id, isOnline) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = isOnline ? 'api-status online' : 'api-status offline';
}

function checkApiStatus() {
    // Reset all to checking
    ['status-server', 'status-brain', 'status-usitc', 'status-icegate'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.className = 'api-status checking';
    });

    fetch('/api/ping')
        .then(response => {
            if (!response.ok) throw new Error('API returned non-ok status');
            return response.json();
        })
        .then(data => {
            updateIndicator('status-server', data.server);
            updateIndicator('status-brain', data.huggingFace || data.openRouter);
            const brainLabel = document.getElementById('brain-label');
            if (brainLabel && data.brain) {
                brainLabel.textContent = data.brain.includes('Qwen') ? 'Qwen 3.8' : 'AI Brain';
            }
            
            // HTSC (USITC) status: show disabled / Off cleanly when turned off
            const usitcEl = document.getElementById('status-usitc');
            if (usitcEl) {
                if (data.usitc === 'disabled' || data.usitc === false) {
                    usitcEl.className = 'api-status disabled';
                    usitcEl.querySelector('.status-text').textContent = 'HTSC: Off';
                } else {
                    usitcEl.className = 'api-status online';
                    usitcEl.querySelector('.status-text').textContent = 'HTSC: On';
                }
            }

            // ICEGate status
            const iceEl = document.getElementById('status-icegate');
            if (iceEl) {
                iceEl.className = data.icegate ? 'api-status online' : 'api-status offline';
                iceEl.querySelector('.status-text').textContent = 'ICEGate';
            }
        })
        .catch(error => {
            console.error('API Status Check Failed:', error);
            updateIndicator('status-server', false);
            updateIndicator('status-brain', false);
            const usitcEl = document.getElementById('status-usitc');
            if (usitcEl) {
                usitcEl.className = 'api-status disabled';
                usitcEl.querySelector('.status-text').textContent = 'HTSC: Off';
            }
            updateIndicator('status-icegate', false);
        });
}

// Check immediately on load, then every 30 seconds
checkApiStatus();
setInterval(checkApiStatus, 30000);

// ── Teach Modal Logic ──
const teachModal = document.getElementById('teach-modal');
const closeModal = document.getElementById('close-modal');
const teachForm = document.getElementById('teach-form');
const teachDisplayTitle = document.getElementById('teach-display-title');
const teachOriginalTitle = document.getElementById('teach-original-title');
const teachHsCode = document.getElementById('teach-hs-code');
const teachSubmitBtn = document.getElementById('teach-submit-btn');

document.addEventListener('click', (e) => {
    if (e.target.classList.contains('teach-btn')) {
        const title = e.target.getAttribute('data-title');
        teachOriginalTitle.value = title;
        teachDisplayTitle.textContent = title;
        teachHsCode.value = '';
        teachModal.classList.remove('hidden');
        teachHsCode.focus();
    }
});

closeModal.addEventListener('click', () => {
    teachModal.classList.add('hidden');
});

teachModal.addEventListener('click', (e) => {
    if (e.target === teachModal) {
        teachModal.classList.add('hidden');
    }
});

teachForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const productTitle = teachOriginalTitle.value;
    const correctHsCode = teachHsCode.value.replace(/\./g, '');

    teachSubmitBtn.textContent = 'Saving...';
    teachSubmitBtn.disabled = true;

    try {
        const response = await fetch('/api/teach', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productTitle, correctHsCode })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Failed to save correction');
        }

        teachModal.classList.add('hidden');
        alert('Correction saved! Please re-run the classification to see the updated results.');
        
    } catch (err) {
        alert('Error: ' + err.message);
    } finally {
        teachSubmitBtn.textContent = 'Save Correction';
        teachSubmitBtn.disabled = false;
    }
});
