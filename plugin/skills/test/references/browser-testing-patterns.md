# Browser Testing Patterns

Common patterns for Chrome DevTools MCP browser automation.

## Quick Reference

| Task | Pattern |
|------|---------|
| Find element UIDs | `take_snapshot()` |
| Visual documentation | `take_screenshot()` |
| Wait for content | `wait_for({text: "..."})` |
| Fill input field | `fill({uid: "...", value: "..."})` |
| Click element | `click({uid: "..."})` |
| Double-click | `click({uid: "...", dblClick: true})` |
| Keyboard input | `press_key({key: "Enter"})` |
| Handle dialog | `handle_dialog({action: "accept"})` |

## Form Testing

Standard pattern for testing forms (login, search, data entry):

```javascript
// Step 1: Navigate and identify form fields
navigate_page({url: "{{DEV_URL}}/login"})
take_snapshot()  // Find UIDs for form elements

// Step 2: Fill form fields
fill({uid: "email-input", value: "test@example.com"})
fill({uid: "password-input", value: "secure123"})

// Step 3: Submit form
click({uid: "submit-button"})

// Step 4: Verify result
wait_for({text: "Welcome"})  // or error message
take_snapshot()  // Confirm expected state
```

**Variations:**

```javascript
// Multi-step form
click({uid: "next-button"})
take_snapshot()  // Get next step fields
fill({uid: "step2-field", value: "..."})

// Form with select/dropdown
click({uid: "category-select"})
take_snapshot()  // See dropdown options
click({uid: "option-technology"})

// Form with checkboxes
click({uid: "terms-checkbox"})
click({uid: "newsletter-checkbox"})
```

## Modal Testing

Pattern for modal dialogs (confirmations, forms, alerts):

```javascript
// Step 1: Open modal
click({uid: "open-modal-button"})

// Step 2: Verify modal appeared
take_snapshot()  // Modal content should be in tree

// Step 3: Interact with modal content
fill({uid: "modal-input", value: "test data"})

// Step 4: Confirm or cancel
click({uid: "confirm-button"})  // or cancel-button

// Step 5: Verify modal closed
take_snapshot()  // Modal should not be in tree
```

**Nested modal handling:**

```javascript
// First modal opens second modal
click({uid: "open-first-modal"})
take_snapshot()

click({uid: "open-nested-modal"})
take_snapshot()  // Verify nested modal

click({uid: "nested-confirm"})
take_snapshot()  // Back to first modal

click({uid: "first-confirm"})
take_snapshot()  // All modals closed
```

**Escape key to close:**

```javascript
click({uid: "open-modal"})
take_snapshot()  // Modal open

press_key({key: "Escape"})
take_snapshot()  // Modal should close
```

## Grid/Table Testing

Pattern for data grids (AG Grid, TanStack Table, custom tables):

```javascript
// Step 1: Navigate to grid view
navigate_page({url: "{{DEV_URL}}/admin/data"})
take_snapshot()  // Identify cell UIDs

// Step 2: Enter edit mode
click({uid: "cell-row1-col2", dblClick: true})

// Step 3: Edit cell value
fill({uid: "cell-input", value: "new value"})

// Step 4: Confirm edit
press_key({key: "Enter"})

// Step 5: Verify change
take_snapshot()  // Cell should show new value
```

**Row selection:**

```javascript
// Single row select
click({uid: "row-1"})
take_snapshot()  // Verify selection styling

// Multi-row select (shift+click)
// Note: MCP may not support modifier keys, use checkboxes instead
click({uid: "row-1-checkbox"})
click({uid: "row-3-checkbox"})
```

**Column sorting:**

```javascript
click({uid: "header-name"})
take_snapshot()  // Ascending order

click({uid: "header-name"})
take_snapshot()  // Descending order
```

**Pagination:**

```javascript
click({uid: "page-2-button"})
wait_for({text: "Page 2"})  // or wait for different content
take_snapshot()
```

## Multi-Select Testing

Pattern for testing bulk selection and actions:

```javascript
// Step 1: Get initial state
take_snapshot()  // Note initial selection count

// Step 2: Select multiple items
click({uid: "item-1-checkbox"})
take_snapshot()  // Verify "1 selected"

click({uid: "item-3-checkbox"})
take_snapshot()  // Verify "2 selected"

click({uid: "item-5-checkbox"})
take_snapshot()  // Verify "3 selected"

// Step 3: Perform bulk action
click({uid: "bulk-delete-button"})

// Step 4: Confirm action (if modal appears)
take_snapshot()  // Verify confirmation modal
click({uid: "confirm-delete"})

// Step 5: Verify result
take_snapshot()  // Items should be removed
```

**Select all / deselect all:**

```javascript
// Select all
click({uid: "select-all-checkbox"})
take_snapshot()  // All items checked

// Deselect all
click({uid: "select-all-checkbox"})
take_snapshot()  // All items unchecked
```

## Async Content

Pattern for content that loads asynchronously:

```javascript
// Step 1: Trigger async load
click({uid: "load-data-button"})

// Step 2: Wait for loading indicator (optional)
wait_for({text: "Loading..."})

// Step 3: Wait for content to appear
wait_for({text: "Expected content"})

// Step 4: Verify final state
take_snapshot()
```

**Search with debounce:**

```javascript
fill({uid: "search-input", value: "query"})

// Wait for debounced search
wait_for({text: "Search results"})
take_snapshot()
```

**Infinite scroll:**

```javascript
// Scroll is not directly supported, use page down or click "load more"
click({uid: "load-more-button"})
wait_for({text: "Item 21"})  // Wait for new items
take_snapshot()
```

**Polling data:**

```javascript
// For auto-refreshing data, wait for updated content
wait_for({text: "Updated 5 seconds ago"})
take_snapshot()
```

## Screenshots vs Snapshots

| Feature | `take_snapshot()` | `take_screenshot()` |
|---------|-------------------|---------------------|
| Output | Text-based accessibility tree | Visual image |
| Speed | Faster | Slower |
| Element UIDs | Yes | No |
| Layout verification | No | Yes |
| Color/styling | No | Yes |
| Use before interactions | **Required** | Optional |
| Documentation/evidence | Limited | **Preferred** |

**When to use each:**

```javascript
// Finding elements to interact with
take_snapshot()  // REQUIRED - gives you UIDs

// Documenting visual state for test report
take_screenshot()  // Shows actual appearance

// Verifying element exists/text present
take_snapshot()  // Sufficient for text checks

// Verifying CSS, colors, layout
take_screenshot()  // Required for visual checks

// Before/after comparison
take_snapshot()   // For state comparison
take_screenshot() // For visual comparison
```

**Combined usage:**

```javascript
// Standard test flow
take_snapshot()         // 1. Find elements
click({uid: "button"})  // 2. Interact
take_snapshot()         // 3. Verify state change
take_screenshot()       // 4. Document visual result
```

## Troubleshooting

### Element Not Found

**Symptom:** Click/fill fails with "element not found"

**Solutions:**

```javascript
// 1. Take a fresh snapshot to see current state
take_snapshot()

// 2. Element might be hidden/not rendered yet
wait_for({text: "expected text nearby"})
take_snapshot()

// 3. Check if element is in a modal/iframe
// Take snapshot with modal open
click({uid: "open-modal"})
take_snapshot()  // Now modal elements visible

// 4. Element may have dynamic UID
// Look for patterns in the UID name
```

### Timeout Errors

**Symptom:** `wait_for` times out

**Solutions:**

```javascript
// 1. Verify content actually loads
take_snapshot()  // Check current state

// 2. Content might have different text
wait_for({text: "partial match"})  // Use substring

// 3. Content might be in different element
// Check if it's in an iframe or shadow DOM

// 4. Server might be slow
// Ensure dev server is running: lsof -ti:<PORT>
// (extract port from DEV_URL in config.json)
```

### Dialog Handling

**Symptom:** Unexpected browser dialog blocks execution

**Solutions:**

```javascript
// Handle alert/confirm dialogs
handle_dialog({action: "accept"})  // Click OK
handle_dialog({action: "dismiss"}) // Click Cancel

// Handle before triggering action that shows dialog
// Some dialogs appear immediately after action
click({uid: "delete-button"})
handle_dialog({action: "accept"})
```

### Form Submission Issues

**Symptom:** Form doesn't submit or shows validation errors

**Solutions:**

```javascript
// 1. Check for validation errors
take_snapshot()  // Look for error messages

// 2. Ensure required fields are filled
fill({uid: "required-field", value: "value"})

// 3. Try alternative submit methods
click({uid: "submit-button"})  // Button click
// OR
press_key({key: "Enter"})  // Keyboard submit

// 4. Wait for form to be ready
wait_for({text: "Form loaded"})
take_snapshot()
```

### State Not Updating

**Symptom:** UI doesn't reflect expected changes

**Solutions:**

```javascript
// 1. Wait for state to propagate
wait_for({text: "expected new text"})

// 2. Trigger a re-render
click({uid: "refresh-button"})  // If available

// 3. Navigate away and back
navigate_page({url: "other-page"})
navigate_page({url: "original-page"})
take_snapshot()

// 4. Check network tab for failed requests
// (Manual inspection may be needed)
```

### Multiple Elements with Same Text

**Symptom:** Clicking wrong element

**Solutions:**

```javascript
// 1. Use more specific UID
// UIDs are unique - find the exact one from snapshot

// 2. Look at parent context in snapshot tree
// Elements are nested - find the right level

// 3. Take screenshot to visually identify
take_screenshot()
```

## Common MCP Functions Reference

| Function | Purpose | Example |
|----------|---------|---------|
| `navigate_page` | Go to URL | `{url: "http://..."}` |
| `take_snapshot` | Get accessibility tree | No params needed |
| `take_screenshot` | Capture visual image | No params needed |
| `click` | Click element | `{uid: "button-1"}` |
| `fill` | Enter text | `{uid: "input", value: "text"}` |
| `press_key` | Keyboard input | `{key: "Enter"}` or `{key: "Escape"}` |
| `wait_for` | Wait for content | `{text: "Loading..."}` |
| `handle_dialog` | Browser dialog | `{action: "accept"}` or `{action: "dismiss"}` |
| `scroll_page` | Scroll viewport | `{direction: "down"}` |
