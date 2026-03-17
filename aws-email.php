<?php
/**
 * AWS SES SMTP Email Sender using PHPMailer
 * 
 * This script sends emails using AWS SES SMTP credentials with PHPMailer.
 * 
 * Installation:
 *   composer require phpmailer/phpmailer
 * 
 * Usage:
 *   require_once 'aws-email.php';
 *   $result = sendAwsEmail('recipient@example.com', 'Subject', 'Body text');
 */

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\SMTP;
use PHPMailer\PHPMailer\Exception;

// Load Composer autoloader
require_once __DIR__ . '/vendor/autoload.php';

// ============================================
// AWS SES SMTP Configuration
// ============================================
$awsConfig = [
    'smtp_host'     => 'email-smtp.ap-southeast-2.amazonaws.com',  // Change region as needed
    'smtp_port'     => 587,                                         // Use 587 for TLS, 465 for SSL
    'smtp_username' => 'YOUR_SMTP_USERNAME',                        // AWS SES SMTP username
    'smtp_password' => 'YOUR_SMTP_PASSWORD',                        // AWS SES SMTP password
    'from_email'    => 'noreply@update247.com.au',                  // Verified sender email
    'from_name'     => 'Update247'                                  // Sender name
];

/**
 * Send email using AWS SES SMTP via PHPMailer
 * 
 * @param string $to          Recipient email address
 * @param string $subject     Email subject
 * @param string $body        Email body (plain text)
 * @param string $bodyHtml    Optional HTML body
 * @param array  $attachments Optional attachments [['path' => '/path/to/file.pdf', 'name' => 'file.pdf']] 
 *                            or [['content' => '...', 'name' => 'file.pdf', 'type' => 'application/pdf']]
 * @param array  $cc          Optional CC recipients
 * @param array  $bcc         Optional BCC recipients
 * @return array ['success' => bool, 'message' => string, 'messageId' => string|null]
 */
function sendAwsEmail($to, $subject, $body, $bodyHtml = null, $attachments = [], $cc = [], $bcc = []) {
    global $awsConfig;
    
    $mail = new PHPMailer(true);
    
    try {
        // Server settings
        $mail->isSMTP();
        $mail->Host       = $awsConfig['smtp_host'];
        $mail->SMTPAuth   = true;
        $mail->Username   = $awsConfig['smtp_username'];
        $mail->Password   = $awsConfig['smtp_password'];
        $mail->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS;
        $mail->Port       = $awsConfig['smtp_port'];
        
        // Sender
        $mail->setFrom($awsConfig['from_email'], $awsConfig['from_name']);
        
        // Recipients
        if (is_array($to)) {
            foreach ($to as $recipient) {
                $mail->addAddress($recipient);
            }
        } else {
            $mail->addAddress($to);
        }
        
        // CC
        foreach ($cc as $ccRecipient) {
            $mail->addCC($ccRecipient);
        }
        
        // BCC
        foreach ($bcc as $bccRecipient) {
            $mail->addBCC($bccRecipient);
        }
        
        // Attachments
        foreach ($attachments as $attachment) {
            if (isset($attachment['path'])) {
                // File path attachment
                $name = $attachment['name'] ?? basename($attachment['path']);
                $mail->addAttachment($attachment['path'], $name);
            } elseif (isset($attachment['content'])) {
                // String content attachment
                $mail->addStringAttachment(
                    $attachment['content'],
                    $attachment['name'] ?? 'attachment',
                    PHPMailer::ENCODING_BASE64,
                    $attachment['type'] ?? 'application/octet-stream'
                );
            }
        }
        
        // Content
        $mail->CharSet = 'UTF-8';
        
        if ($bodyHtml) {
            $mail->isHTML(true);
            $mail->Subject = $subject;
            $mail->Body    = $bodyHtml;
            $mail->AltBody = $body;
        } else {
            $mail->isHTML(false);
            $mail->Subject = $subject;
            $mail->Body    = $body;
        }
        
        // Send
        $mail->send();
        
        return [
            'success'   => true,
            'message'   => 'Email sent successfully',
            'messageId' => $mail->getLastMessageID()
        ];
        
    } catch (Exception $e) {
        return [
            'success'   => false,
            'message'   => "Email failed: {$mail->ErrorInfo}",
            'messageId' => null
        ];
    }
}

/**
 * Send a simple text email
 */
function sendAwsEmailSimple($to, $subject, $body) {
    return sendAwsEmail($to, $subject, $body);
}

/**
 * Send email with HTML content
 */
function sendAwsEmailHtml($to, $subject, $htmlBody, $textBody = null) {
    $textBody = $textBody ?? strip_tags($htmlBody);
    return sendAwsEmail($to, $subject, $textBody, $htmlBody);
}

/**
 * Send email with attachments
 */
function sendAwsEmailWithAttachments($to, $subject, $body, $attachments) {
    return sendAwsEmail($to, $subject, $body, null, $attachments);
}

// ============================================
// Example Usage (when run directly)
// ============================================
if (php_sapi_name() === 'cli' && basename(__FILE__) === basename($argv[0] ?? '')) {
    echo "AWS SES Email Test (PHPMailer)\n";
    echo "==============================\n\n";
    
    // Test email
    $to = 'test@example.com';
    $subject = 'Test Email from AWS SES';
    $body = "Hello,\n\nThis is a test email sent via AWS SES SMTP using PHPMailer.\n\nRegards,\nUpdate247";
    
    echo "Sending test email to: {$to}\n";
    
    $result = sendAwsEmail($to, $subject, $body);
    
    if ($result['success']) {
        echo "✓ {$result['message']}\n";
        echo "Message ID: {$result['messageId']}\n";
    } else {
        echo "✗ Error: {$result['message']}\n";
    }
}

/*
 * ============================================
 * Usage Examples
 * ============================================
 *
 * // Simple text email
 * $result = sendAwsEmail('customer@example.com', 'Hello', 'This is the message body.');
 *
 * // HTML email
 * $result = sendAwsEmail(
 *     'customer@example.com',
 *     'Welcome!',
 *     'Plain text version',
 *     '<h1>Welcome!</h1><p>HTML version</p>'
 * );
 *
 * // With file attachment
 * $result = sendAwsEmail(
 *     'customer@example.com',
 *     'Your Report',
 *     'Please find attached your report.',
 *     null,
 *     [['path' => '/path/to/report.pdf', 'name' => 'Monthly-Report.pdf']]
 * );
 *
 * // With string content attachment
 * $result = sendAwsEmail(
 *     'customer@example.com',
 *     'Your Data',
 *     'Please find attached your data.',
 *     null,
 *     [[
 *         'content' => json_encode(['data' => 'value']),
 *         'name' => 'data.json',
 *         'type' => 'application/json'
 *     ]]
 * );
 *
 * // Multiple recipients with CC and BCC
 * $result = sendAwsEmail(
 *     ['user1@example.com', 'user2@example.com'],
 *     'Team Update',
 *     'Message body',
 *     null,
 *     [],
 *     ['cc@example.com'],      // CC
 *     ['bcc@example.com']      // BCC
 * );
 */
?>
