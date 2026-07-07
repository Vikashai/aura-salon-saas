# Release checklist

- [ ] MySQL schema initialized and record totals verified
- [ ] Default admin password replaced with a strong unique password
- [ ] `SESSION_SECRET` is a long random value
- [ ] HTTPS is enabled and `APP_BASE_URL` uses the final HTTPS domain
- [ ] Login, logout and protected routes work
- [ ] Dashboard totals match the Flask reference
- [ ] Customer create, edit, profile and archive work
- [ ] Bill totals, GST, loyalty redemption and printable invoice match
- [ ] Services, staff, inventory, packages and expenses work
- [ ] Reports and CSV export work
- [ ] Appointment slot conflicts are blocked and public booking works
- [ ] Confirmation, reminder and cancellation templates are approved and tested
- [ ] Meta token and SMTP password are stored only in protected settings/environment configuration
- [ ] Public cancellation link works on the final domain
- [ ] Mobile navigation and public booking layout are checked
- [ ] A final database backup has been downloaded
