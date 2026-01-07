# Security Checklists Reference

Detailed checklists for each security domain, used by the `/security-review` skill.

## Authentication Checklist (AUTH)

### AUTH-1: Password Hashing
**Requirement:** Passwords must use bcrypt/argon2 with appropriate cost factor.

**How to Verify:**
```bash
grep -r "bcrypt\|argon2\|hashPassword" lib/ app/
```

**Good:**
```typescript
import bcrypt from 'bcryptjs'
const hash = await bcrypt.hash(password, 12)
```

**Bad:**
```typescript
const hash = crypto.createHash('sha256').update(password).digest('hex')
```

### AUTH-2: Session Token Randomness
**Requirement:** Session tokens must be cryptographically random.

**How to Verify:**
```bash
grep -r "crypto.randomBytes\|uuid\|nanoid" lib/auth/
```

**Good:**
```typescript
const token = crypto.randomBytes(32).toString('hex')
```

**Bad:**
```typescript
const token = Date.now().toString(36)
```

### AUTH-3: Session Expiration
**Requirement:** Sessions must expire within appropriate timeframe.

**How to Verify:**
```bash
grep -r "maxAge\|expires\|TTL" lib/auth/ app/api/auth/
```

**Good:** 15-60 minutes for sensitive, 1-7 days for general.

**Bad:** No expiration or "remember me" without user consent.

### AUTH-4: Logout Invalidation
**Requirement:** Logout must invalidate session server-side.

**How to Verify:**
- Check logout handler deletes session from store
- Verify token is invalidated, not just cleared from client

### AUTH-5: Password Reset Tokens
**Requirement:** Reset tokens must be single-use and time-limited.

**How to Verify:**
```bash
grep -r "resetToken\|passwordReset" lib/ app/
```

**Good:** Token expires in 1 hour, deleted after use.

**Bad:** Token reusable, no expiration.

### AUTH-6: Login Rate Limiting
**Requirement:** Failed login attempts must be rate-limited.

**How to Verify:**
```bash
grep -r "rateLimit\|loginAttempts\|throttle" lib/ app/api/auth/
```

**Good:** 5 attempts per 15 minutes.

### AUTH-7: Timing Attack Prevention
**Requirement:** Password comparison must be constant-time.

**How to Verify:**
```bash
grep -r "timingSafeEqual\|bcrypt.compare" lib/auth/
```

**Good:**
```typescript
await bcrypt.compare(input, hash)  // bcrypt is constant-time
```

**Bad:**
```typescript
if (input === password) // Direct comparison leaks timing info
```

### AUTH-8: MFA Implementation
**Requirement:** If MFA is implemented, it must be properly enforced.

**How to Verify:**
- Check MFA cannot be bypassed
- Verify backup codes are single-use
- Confirm TOTP secrets are stored securely

---

## Authorization Checklist (AUTHZ)

### AUTHZ-1: Authentication on All Endpoints
**Requirement:** Every sensitive endpoint must check authentication.

**How to Verify:**
```bash
grep -r "requireAuth\|getServerSession\|authenticate" app/api/ app/admin/
```

**Good:** Middleware checks auth before route handler.

**Bad:** Route handler assumes auth without checking.

### AUTHZ-2: RBAC Enforcement
**Requirement:** Role checks must happen before privileged actions.

**How to Verify:**
```bash
grep -r "role\|isAdmin\|hasPermission" lib/ app/
```

**Good:**
```typescript
if (user.role !== 'admin') throw new ForbiddenError()
```

**Bad:**
```typescript
// Role stored in frontend, not verified server-side
```

### AUTHZ-3: IDOR Prevention
**Requirement:** Object access must verify user owns/can access the object.

**How to Verify:**
- Check queries filter by user_id or org_id
- Verify route params can't access other users' data

**Bad:**
```typescript
const item = await db.items.findUnique({ where: { id: itemId } })
// Missing: ownership verification (e.g., where: { id: itemId, owner_id: user.id })
```

### AUTHZ-4: Horizontal Privilege Escalation
**Requirement:** Users cannot access other users' resources at same privilege level.

**How to Verify:**
- Review list queries for proper scoping
- Check bulk operations filter by user

### AUTHZ-5: Vertical Privilege Escalation
**Requirement:** Lower-privilege users cannot perform admin actions.

**How to Verify:**
- Check admin routes have role verification
- Verify form submissions validate permissions

### AUTHZ-6: Audit Logging
**Requirement:** Admin actions must be logged for audit.

**How to Verify:**
```bash
grep -r "audit\|logAction\|createAuditLog" lib/ app/admin/
```

**Good:**
```typescript
await logAuditEvent({ action: 'approve_item', actor: userId, target: itemId })
```

---

## API Security Checklist (API)

### API-1: Input Validation
**Requirement:** All inputs must be validated with schemas.

**How to Verify:**
```bash
grep -r "z\.\|zod\|yup\|joi" lib/validations/ app/api/
```

**Good:**
```typescript
const schema = z.object({ name: z.string().min(1).max(100) })
```

**Bad:**
```typescript
const { name } = req.body // No validation
```

### API-2: XSS Prevention
**Requirement:** Output must be properly encoded.

**How to Verify:**
- React/Next.js auto-escapes by default
- Check for `dangerouslySetInnerHTML` usage
- Verify markdown rendering is sanitized

### API-3: SQL Injection Prevention
**Requirement:** Queries must use parameterized statements.

**How to Verify:**
```bash
grep -r "raw\|execute\|query" lib/ app/
```

**Good:**
```typescript
// Using ORM with parameterized queries
db.items.findUnique({ where: { id: itemId } })
// Or query builder with parameters
db.from('items').select('*').eq('id', itemId)
```

**Bad:**
```typescript
db.query(`SELECT * FROM items WHERE id = ${itemId}`)
```

### API-4: Rate Limiting
**Requirement:** Public endpoints must be rate-limited.

**How to Verify:**
```bash
grep -r "rateLimit\|Ratelimit" middleware/ lib/
```

### API-5: CORS Configuration
**Requirement:** CORS must be properly configured.

**How to Verify:**
```bash
grep -r "cors\|Access-Control" next.config.js middleware/
```

**Good:** Specific origins allowed.

**Bad:** `Access-Control-Allow-Origin: *` for authenticated endpoints.

### API-6: Error Message Safety
**Requirement:** Error messages must not leak sensitive info.

**How to Verify:**
- Check error responses in production mode
- Verify stack traces not exposed

**Good:**
```typescript
return { error: 'Authentication failed' }
```

**Bad:**
```typescript
return { error: err.message, stack: err.stack }
```

### API-7: File Upload Validation
**Requirement:** Uploads must validate type, size, and name.

**How to Verify:**
```bash
grep -r "upload\|multipart\|formData" app/api/ lib/
```

**Good:**
```typescript
if (!['image/jpeg', 'image/png'].includes(file.type)) throw Error
if (file.size > 5 * 1024 * 1024) throw Error
```

---

## Data Protection Checklist (DATA)

### DATA-1: Encryption at Rest
**Requirement:** Sensitive data must be encrypted in database.

**How to Verify:**
- Verify database uses encryption at rest (most cloud providers enable by default)
- Check for additional encryption on highly sensitive fields

### DATA-2: Encryption in Transit
**Requirement:** All communications must use HTTPS.

**How to Verify:**
- Vercel enforces HTTPS automatically
- Check for HTTP references in code

### DATA-3: PII Handling
**Requirement:** PII must be handled per privacy policy.

**How to Verify:**
- Check what user data is collected
- Verify data retention policies
- Confirm deletion procedures

### DATA-4: Log Safety
**Requirement:** Logs must not contain sensitive data.

**How to Verify:**
```bash
grep -r "console.log\|logger" lib/ app/ | head -20
```

**Bad:**
```typescript
console.log('User login:', { email, password })
```

### DATA-5: Query Authorization
**Requirement:** Queries must respect user permissions.

**How to Verify:**
- Check RLS policies exist for tables
- Verify public client can't read unauthorized data

---

## Infrastructure Checklist (INFRA)

### INFRA-1: Environment Variable Protection
**Requirement:** Secrets must be in env vars, not code.

**How to Verify:**
```bash
grep -r "process.env" lib/ app/ | head -10
```

**Good:** API keys in `.env.local`, read via `process.env`.

**Bad:** API key hardcoded in source file.

### INFRA-2: No Hardcoded Secrets
**Requirement:** No secrets committed to repository.

**How to Verify:**
```bash
grep -ri "password\|secret\|apikey\|api_key" --include="*.ts" --include="*.tsx" . | grep -v "process.env"
```

### INFRA-3: Dependencies Up to Date
**Requirement:** No known vulnerable dependencies.

**How to Verify:**
```bash
npm audit
```

### INFRA-4: CSP Headers
**Requirement:** Content Security Policy should be configured.

**How to Verify:**
```bash
grep -r "Content-Security-Policy\|CSP" next.config.js middleware/
```

### INFRA-5: Security Headers
**Requirement:** Standard security headers must be set.

**How to Verify:**
- X-Frame-Options: DENY
- X-Content-Type-Options: nosniff
- Strict-Transport-Security: max-age=...
