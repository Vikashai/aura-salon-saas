'use strict';

const nodemailer = require('nodemailer');
const { fmtTime } = require('./helpers');

function normalizeNumber(input) {
  let number = String(input || '').replace(/\D/g, '');
  if (number.length === 10) number = `91${number}`;
  if (number.length === 11 && number.startsWith('0')) number = `91${number.slice(1)}`;
  return number;
}

function validNumber(input) {
  const number = normalizeNumber(input);
  return number.length >= 8 && number.length <= 15 ? number : null;
}

async function sendWhatsApp(settings, recipient, message, templateName, parameters = []) {
  const number = validNumber(recipient);
  if (!number) return { channel: 'whatsapp', ok: false, message: 'Invalid international phone number' };
  const provider = (settings.whatsapp_provider || 'meta').toLowerCase();

  if (provider === 'twilio') {
    if (!settings.twilio_sid || !settings.twilio_token) {
      return { channel: 'whatsapp', ok: false, message: 'Twilio is not configured' };
    }
    const body = new URLSearchParams({
      From: settings.twilio_whatsapp_from || 'whatsapp:+14155238886',
      To: `whatsapp:+${number}`,
      Body: message,
    });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${settings.twilio_sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${settings.twilio_sid}:${settings.twilio_token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const data = await response.json().catch(() => ({}));
    return response.ok
      ? { channel: 'whatsapp', ok: true, message: data.sid || 'sent' }
      : { channel: 'whatsapp', ok: false, message: data.message || `HTTP ${response.status}` };
  }

  if (!settings.meta_whatsapp_token || !settings.meta_phone_number_id) {
    return { channel: 'whatsapp', ok: false, message: 'Meta token or Phone Number ID is missing' };
  }
  const payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to: number };
  if (templateName) {
    payload.type = 'template';
    payload.template = {
      name: templateName,
      language: { code: settings.meta_template_language || 'en_US' },
    };
    if (parameters.length) {
      payload.template.components = [{
        type: 'body',
        parameters: parameters.map(value => ({ type: 'text', text: String(value || '-') })),
      }];
    }
  } else {
    payload.type = 'text';
    payload.text = { preview_url: true, body: message };
  }
  const version = settings.meta_api_version || 'v25.0';
  const response = await fetch(`https://graph.facebook.com/${version}/${settings.meta_phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.meta_whatsapp_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (response.ok) return { channel: 'whatsapp', ok: true, message: data.messages?.[0]?.id || 'sent' };
  const error = data.error || {};
  return {
    channel: 'whatsapp', ok: false,
    message: [error.message, error.error_data?.details].filter(Boolean).join(' - ') || `HTTP ${response.status}`,
  };
}

async function sendEmail(settings, recipient, subject, html) {
  if (!recipient) return { channel: 'email', ok: false, message: 'No recipient email' };
  if (!settings.smtp_user || !settings.smtp_pass) {
    return { channel: 'email', ok: false, message: 'SMTP credentials are missing' };
  }
  const transport = nodemailer.createTransport({
    host: settings.smtp_host || 'smtp.gmail.com',
    port: Number(settings.smtp_port || 587),
    secure: Number(settings.smtp_port || 587) === 465,
    auth: { user: settings.smtp_user, pass: settings.smtp_pass },
  });
  const info = await transport.sendMail({
    from: `${settings.salon_name || 'Aura Salon'} <${settings.smtp_from || settings.smtp_user}>`,
    to: recipient,
    subject,
    html,
  });
  return { channel: 'email', ok: true, message: info.messageId };
}

async function sendPlatformEmail(recipient, subject, html) {
  return sendEmail({
    salon_name: process.env.SMTP_FROM_NAME || 'Aura Salon OS',
    smtp_host: process.env.SMTP_HOST || 'smtp.gmail.com',
    smtp_port: process.env.SMTP_PORT || '587',
    smtp_user: process.env.SMTP_USER || '',
    smtp_pass: process.env.SMTP_PASSWORD || '',
    smtp_from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
  }, recipient, subject, html);
}

function bookingValues(settings, appointment, type) {
  const time = fmtTime(appointment.appointment_time);
  const staff = appointment.staff_name || 'Any Available';
  if (type === 'confirmation') {
    const base = (settings.base_url || process.env.APP_BASE_URL || '').replace(/\/$/, '');
    return [appointment.customer_name, appointment.appointment_id, appointment.service_name,
      appointment.appointment_date, time, staff, `Rs ${Number(appointment.amount || 0).toLocaleString('en-IN')}`,
      base ? `${base}/book/cancel/${appointment.booking_token}${settings.salon_slug?`?salon=${encodeURIComponent(settings.salon_slug)}`:''}` : '-'];
  }
  if (type === 'reminder') return [appointment.customer_name, appointment.service_name, appointment.appointment_date, time, staff];
  return [appointment.customer_name, appointment.service_name, appointment.appointment_date, time];
}

function bookingMessage(settings, appointment, type) {
  const salon = settings.salon_name || 'Aura Salon';
  const time = fmtTime(appointment.appointment_time);
  if (type === 'confirmation') return `Booking confirmed at ${salon}\n${appointment.service_name}\n${appointment.appointment_date} at ${time}`;
  if (type === 'reminder') return `Reminder from ${salon}: ${appointment.service_name} tomorrow at ${time}`;
  return `Your ${appointment.service_name} appointment at ${salon} has been cancelled.`;
}

async function sendBookingNotifications(settings, appointment, type) {
  const results = [];
  const title = type === 'confirmation' ? 'Booking Confirmed' : type === 'reminder' ? 'Appointment Reminder' : 'Booking Cancelled';
  const message = bookingMessage(settings, appointment, type);
  if (appointment.notify_email && appointment.customer_email) {
    results.push(await sendEmail(settings, appointment.customer_email,
      `${title} - ${appointment.service_name} at ${settings.salon_name || 'Aura Salon'}`,
      `<p>Hi ${appointment.customer_name},</p><p>${message.replace(/\n/g, '<br>')}</p>`));
  }
  if (appointment.notify_whatsapp && appointment.customer_mobile) {
    const key = `meta_template_${type}`;
    results.push(await sendWhatsApp(settings, appointment.customer_mobile, message,
      String(settings[key] || '').trim() || null, bookingValues(settings, appointment, type)));
  }
  return results;
}

module.exports = { normalizeNumber, validNumber, sendWhatsApp, sendEmail, sendPlatformEmail, sendBookingNotifications };
