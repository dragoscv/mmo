//! DeviceSQL (".pdb") binary primitives.
//!
//! Format reference: Deep-Symmetry `crate-digger` (`rekordbox_pdb.ksy`) and
//! `rekordcrate`. A pdb file is:
//!   - a 28-byte file header (len_page=4096, num_tables, next_unused_page,
//!     sequence, gap) followed by the table-pointer array, then
//!   - a sequence of 4096-byte pages. Each page has a 40-byte header, a heap
//!     of rows growing forward, and a row-index (presence bitmask + 2-byte
//!     row offsets) growing backward from the page end.
//!
//! This module provides the low-level builders; `pdb.rs` composes tables.
//!
//! NOTE: byte-exactness is verified against the reference USB (`F:`) via the
//! round-trip harness. Strings use DeviceSQL's short/long ASCII + UTF-16
//! encodings.

pub const PAGE_SIZE: usize = 4096;

/// DeviceSQL string encodings.
pub enum DeviceString {
    /// ASCII, length < 127. Encoded as one length byte `(len<<1)|1` then bytes.
    ShortAscii(String),
    /// Longer / wide strings: 0x40 marker, u16 len, pad, UTF-16LE.
    LongUtf16(String),
}

impl DeviceString {
    pub fn best(s: &str) -> DeviceString {
        let ascii = s.is_ascii();
        if ascii && s.len() < 127 {
            DeviceString::ShortAscii(s.to_string())
        } else {
            DeviceString::LongUtf16(s.to_string())
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        match self {
            DeviceString::ShortAscii(s) => {
                let mut out = Vec::with_capacity(s.len() + 1);
                // length byte: (length+1)<<1 | 1  (the +1 includes the header byte)
                let header = (((s.len() + 1) as u8) << 1) | 1;
                out.push(header);
                out.extend_from_slice(s.as_bytes());
                out
            }
            DeviceString::LongUtf16(s) => {
                let utf16: Vec<u16> = s.encode_utf16().collect();
                let body_len = utf16.len() * 2;
                let total = 4 + body_len; // marker+kind, u16 len, then body
                let mut out = Vec::with_capacity(total);
                out.push(0x90); // long string flag (kind: UTF-16LE)
                out.extend_from_slice(&((total as u16).to_le_bytes()));
                out.push(0x00); // padding/unknown
                for u in utf16 {
                    out.extend_from_slice(&u.to_le_bytes());
                }
                out
            }
        }
    }
}

/// A row's raw bytes plus its row-type presence flag.
pub struct RowData {
    pub bytes: Vec<u8>,
}

/// Builder for a single table's pages. Rows are packed into 4096-byte data
/// pages with the backward-growing row index, matching the player's reader.
pub struct TablePages {
    pub pages: Vec<[u8; PAGE_SIZE]>,
    /// Page index (within the whole file) of the first page; filled by the
    /// file assembler.
    pub first_page_global: u32,
    pub last_page_global: u32,
}

/// Max rows per page group in DeviceSQL (the row-presence bitmap is 32 bits
/// per group, with up to 16 row-groups → but a single small-row page commonly
/// holds far fewer). We pack conservatively and let the index encode counts.
pub const ROWS_PER_GROUP: usize = 16;

/// Assemble rows into data pages for one table.
///
/// Page layout (little-endian):
///   0x00 u32 gap (0)
///   0x04 u32 page_index (global)
///   0x08 u32 table_type
///   0x0C u32 next_page (global; 0/last sentinel)
///   0x10 u32 unknown (sequence)
///   0x14 u32 gap
///   0x18 u8  num_rows_small
///   0x19 u8  unknown
///   0x1A u8  unknown (0x34 typical)
///   0x1B u8  page_flags (0x24 = data page)
///   0x1C u16 free_size
///   0x1E u16 used_size
///   0x20 u16 unknown
///   0x22 u16 num_rows_large
///   0x24 u16 unknown
///   0x26 u16 unknown
///   0x28.. heap (rows forward) ... row-index (backward from end)
pub fn build_data_pages(
    table_type: u32,
    rows: &[RowData],
    first_page_global: u32,
) -> TablePages {
    const HEADER: usize = 0x28;
    let mut pages: Vec<[u8; PAGE_SIZE]> = Vec::new();
    let mut idx = 0usize;
    let mut page_global = first_page_global;

    while idx < rows.len() || pages.is_empty() {
        let mut page = [0u8; PAGE_SIZE];
        let mut heap = HEADER;
        // Heap-relative offsets (relative to 0x28), matching crate-digger.
        let mut offsets: Vec<u16> = Vec::new();

        // Index region size for `n` rows. Per the DeviceSQL spec each row
        // group is a fixed 0x24 (36) bytes — 16 × u16 offsets + a u16
        // `row_present_flags` + a u16 `transaction_row_flags` — and groups
        // build backwards from the end of the page.
        const GROUP_BYTES: usize = 0x24;
        let index_bytes_for = |n: usize| -> usize { n.div_ceil(ROWS_PER_GROUP).max(1) * GROUP_BYTES };

        while idx < rows.len() {
            let row = &rows[idx];
            let mut need = row.bytes.len();
            if need % 2 == 1 {
                need += 1; // 2-byte row alignment
            }
            let count = offsets.len() + 1;
            if heap + need + index_bytes_for(count) > PAGE_SIZE {
                break;
            }
            page[heap..heap + row.bytes.len()].copy_from_slice(&row.bytes);
            offsets.push((heap - HEADER) as u16); // relative to 0x28
            heap += need;
            idx += 1;
        }

        let num_rows = offsets.len();
        // Row index, built backwards from the end of the page. Per spec, for
        // group `g` the base is `len_page - g*0x24`, and within the group:
        //   - `row_present_flags` (u2) at base-4
        //   - `transaction_row_flags` (u2) at base   (only in-page for g>0)
        //   - offset of row i at base - (6 + 2*i)
        let groups = num_rows.div_ceil(ROWS_PER_GROUP).max(1);
        for g in 0..groups {
            let base = PAGE_SIZE - g * GROUP_BYTES;
            let start = g * ROWS_PER_GROUP;
            let end = (start + ROWS_PER_GROUP).min(num_rows);
            let mut present: u16 = 0;
            for (bit, r) in (start..end).enumerate() {
                present |= 1 << bit;
                let off_pos = base - 6 - bit * 2;
                page[off_pos..off_pos + 2].copy_from_slice(&offsets[r].to_le_bytes());
            }
            // row_present_flags at base-4.
            page[base - 4..base - 2].copy_from_slice(&present.to_le_bytes());
            // transaction_row_flags at base (top of this group's block). For
            // group 0 this sits at PAGE_SIZE (off-page) and is skipped — the
            // spec never reads it. For lower groups it is in-page; mirror the
            // present flags so edit-tracking readers stay consistent.
            if base < PAGE_SIZE {
                page[base..base + 2].copy_from_slice(&present.to_le_bytes());
            }
        }

        let used = heap - HEADER; // used heap size (excludes 0x28 header)
        let index_total = index_bytes_for(num_rows);
        let free = PAGE_SIZE - heap - index_total;
        let num_row_offsets = num_rows; // all written rows are present

        // Header fields.
        page[0x04..0x08].copy_from_slice(&page_global.to_le_bytes());
        page[0x08..0x0C].copy_from_slice(&table_type.to_le_bytes());
        // next_page filled by assembler when chaining; default next global.
        page[0x0C..0x10].copy_from_slice(&(page_global + 1).to_le_bytes());
        // Packed bitfield at 0x18: num_row_offsets (13 bits) | num_rows (11
        // bits), little-endian over 3 bytes, then page_flags at 0x1B. This is
        // THE field rekordbox reads to count rows — writing num_rows as a
        // plain byte (the old bug) made it read hundreds of phantom rows and
        // report "Device library is corrupted".
        let rc: u32 = (num_row_offsets as u32 & 0x1FFF) | ((num_rows as u32 & 0x7FF) << 13);
        page[0x18] = (rc & 0xFF) as u8;
        page[0x19] = ((rc >> 8) & 0xFF) as u8;
        page[0x1A] = ((rc >> 16) & 0xFF) as u8;
        page[0x1B] = 0x24; // data page flag
        page[0x1C..0x1E].copy_from_slice(&(free as u16).to_le_bytes());
        page[0x1E..0x20].copy_from_slice(&(used as u16).to_le_bytes());
        // transaction_row_count / transaction_row_index — 0 for a clean page.

        pages.push(page);
        page_global += 1;

        if idx >= rows.len() {
            break;
        }
    }

    let last = first_page_global + pages.len() as u32 - 1;
    // Last page should point to itself / sentinel.
    if let Some(last_page) = pages.last_mut() {
        last_page[0x0C..0x10].copy_from_slice(&last.to_le_bytes());
    }

    TablePages {
        pages,
        first_page_global,
        last_page_global: last,
    }
}

/// Little-endian write helpers.
pub fn push_u8(v: &mut Vec<u8>, x: u8) {
    v.push(x);
}

/// Build a table's "first" page (flags 0x64) — an index/placeholder page that
/// precedes the data page(s). rekordbox emits one before every table's data;
/// its `next_page` points at the first data page.
pub fn build_first_page(table_type: u32, page_global: u32, next_page: u32) -> [u8; PAGE_SIZE] {
    let mut page = [0u8; PAGE_SIZE];
    page[0x04..0x08].copy_from_slice(&page_global.to_le_bytes());
    page[0x08..0x0C].copy_from_slice(&table_type.to_le_bytes());
    page[0x0C..0x10].copy_from_slice(&next_page.to_le_bytes());
    // Packed row-count bitfield is 0 (the first page carries no real rows),
    // page_flags = 0x64 marks it as a non-data (index/placeholder) page.
    page[0x18] = 0;
    page[0x19] = 0;
    page[0x1A] = 0;
    page[0x1B] = 0x64; // first/index page flag
    page
}

pub fn push_u16(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_le_bytes());
}
pub fn push_u32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}
