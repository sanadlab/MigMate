


// // Format round name for display
export function formatRoundName(round: string): string {
    switch(round) {
        case '0-premig': return 'Pre-Migration';
        case '1-llmmig': return 'LLM Migration';
        case '2-merge-skipped': return 'Merge Skipped';
        case '3-async_transform': return 'Async Transform';
        default: return round;
    }
}

// // Escape HTML for safety
export function escapeHtml(unsafe: string): string {
    return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/`/g, "&#96;");
}
