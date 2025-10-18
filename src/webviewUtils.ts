import { ROUND_FOLDERS, ROUND_TITLES } from "./constants";



// // Format round name for display
export function formatRoundName(round: string): string {
    switch(round) {
        case ROUND_FOLDERS[0]: return ROUND_TITLES[0];
        case ROUND_FOLDERS[1]: return ROUND_TITLES[1];
        case ROUND_FOLDERS[2]: return ROUND_TITLES[2];
        case ROUND_FOLDERS[3]: return ROUND_TITLES[3];
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
