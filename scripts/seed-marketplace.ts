/**
 * Seed script for marketplace templates
 *
 * Usage:
 *   AWS_PROFILE=rocketeast npx ts-node scripts/seed-marketplace.ts [stage]
 *
 * Examples:
 *   AWS_PROFILE=rocketeast npx ts-node scripts/seed-marketplace.ts dev
 *   AWS_PROFILE=rocketeast npx ts-node scripts/seed-marketplace.ts prod
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';

const stage = process.argv[2] || 'dev';
const region = 'us-east-1';

const dynamoClient = new DynamoDBClient({ region });
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({ region });

const MARKETPLACE_TABLE = `mkpdfs-${stage}-marketplace`;
const ASSETS_BUCKET = `mkpdfs-${stage}-bucket`;
const TEMPLATES_DIR = path.join(__dirname, 'marketplace-templates');

export interface MarketplaceTemplate {
  templateId: string;
  category: 'business' | 'certificates' | 'marketing' | 'personal';
  name: string;
  description: string;
  s3Key: string;
  thumbnailKey: string;
  sampleDataJson: string;
  tags: string[];
  popularity: number;
  createdAt: string;
  updatedAt: string;
}

export const templates: Omit<MarketplaceTemplate, 's3Key' | 'thumbnailKey' | 'createdAt' | 'updatedAt'>[] = [
  // Business Documents
  {
    templateId: 'mp-business-invoice',
    category: 'business',
    name: 'Professional Invoice',
    description: 'Clean, professional invoice template with itemized billing, tax calculations, and payment terms. Perfect for freelancers and small businesses.',
    tags: ['invoice', 'billing', 'professional', 'business'],
    popularity: 0,
    sampleDataJson: JSON.stringify({
      companyName: 'Acme Corp',
      companyAddress: '123 Business Ave, Suite 100, New York, NY 10001',
      companyEmail: 'billing@acmecorp.com',
      clientName: 'Tech Startup Inc',
      clientAddress: '456 Innovation Blvd, San Francisco, CA 94102',
      invoiceNumber: 'INV-2025-001',
      invoiceDate: 'January 15, 2025',
      dueDate: 'February 15, 2025',
      items: [
        { description: 'Web Development Services', quantity: 40, rate: 150, amount: 6000 },
        { description: 'UI/UX Design', quantity: 20, rate: 125, amount: 2500 },
        { description: 'Project Management', quantity: 10, rate: 100, amount: 1000 }
      ],
      subtotal: 9500,
      taxRate: 8,
      taxAmount: 760,
      total: 10260,
      paymentTerms: 'Net 30'
    })
  },
  {
    templateId: 'mp-business-quote',
    category: 'business',
    name: 'Service Quote',
    description: 'Professional quote/estimate template for service-based businesses. Includes detailed service breakdown and validity period.',
    tags: ['quote', 'estimate', 'proposal', 'business'],
    popularity: 0,
    sampleDataJson: JSON.stringify({
      companyName: 'Design Studio Pro',
      companyLogo: '',
      clientName: 'Global Ventures LLC',
      quoteNumber: 'Q-2025-042',
      quoteDate: 'January 10, 2025',
      validUntil: 'February 10, 2025',
      projectTitle: 'Brand Identity Redesign',
      services: [
        { name: 'Brand Strategy & Research', description: 'Market analysis and brand positioning', price: 3500 },
        { name: 'Logo Design', description: 'Primary logo with variations', price: 2500 },
        { name: 'Brand Guidelines', description: 'Comprehensive style guide', price: 1500 }
      ],
      total: 7500,
      notes: 'This quote is valid for 30 days. 50% deposit required to begin work.'
    })
  },
  {
    templateId: 'mp-business-receipt',
    category: 'business',
    name: 'Payment Receipt',
    description: 'Simple, clean payment receipt for confirming transactions. Ideal for retail and service businesses.',
    tags: ['receipt', 'payment', 'confirmation', 'transaction'],
    popularity: 0,
    sampleDataJson: JSON.stringify({
      businessName: 'Corner Coffee Shop',
      businessAddress: '789 Main Street, Portland, OR 97201',
      receiptNumber: 'REC-20250115-001',
      date: 'January 15, 2025',
      time: '10:32 AM',
      items: [
        { name: 'Cappuccino (Large)', quantity: 2, price: 5.50, total: 11.00 },
        { name: 'Blueberry Muffin', quantity: 1, price: 4.25, total: 4.25 }
      ],
      subtotal: 15.25,
      tax: 1.22,
      total: 16.47,
      paymentMethod: 'Credit Card (**** 4242)',
      thankYouMessage: 'Thank you for your purchase!'
    })
  },

  // Certificates
  {
    templateId: 'mp-cert-completion',
    category: 'certificates',
    name: 'Course Completion Certificate',
    description: 'Elegant certificate for course or training completion. Features a professional design with customizable colors and fields.',
    tags: ['certificate', 'course', 'training', 'completion', 'education'],
    popularity: 0,
    sampleDataJson: JSON.stringify({
      title: 'Certificate of Completion',
      recipientName: 'Jane Elizabeth Smith',
      courseName: 'Advanced JavaScript Development',
      courseHours: 40,
      completionDate: 'January 15, 2025',
      instructorName: 'Dr. John Anderson',
      organizationName: 'Tech Academy Online',
      certificateId: 'CERT-2025-JS-001'
    })
  },
  {
    templateId: 'mp-cert-achievement',
    category: 'certificates',
    name: 'Achievement Award',
    description: 'Recognition certificate for outstanding achievements. Perfect for employee recognition, academic awards, or competition winners.',
    tags: ['award', 'achievement', 'recognition', 'excellence'],
    popularity: 0,
    sampleDataJson: JSON.stringify({
      title: 'Certificate of Achievement',
      recipientName: 'Michael Johnson',
      achievementTitle: 'Employee of the Year',
      description: 'In recognition of exceptional dedication, outstanding performance, and significant contributions to our organization.',
      awardDate: 'January 15, 2025',
      presenterName: 'Sarah Williams',
      presenterTitle: 'Chief Executive Officer',
      organizationName: 'Innovation Corp'
    })
  },
  {
    templateId: 'mp-cert-participation',
    category: 'certificates',
    name: 'Participation Certificate',
    description: 'Certificate acknowledging event or program participation. Great for workshops, conferences, and community events.',
    tags: ['participation', 'event', 'workshop', 'conference'],
    popularity: 0,
    sampleDataJson: JSON.stringify({
      title: 'Certificate of Participation',
      recipientName: 'Emily Davis',
      eventName: '2025 Annual Tech Conference',
      eventDate: 'January 15-17, 2025',
      eventLocation: 'San Francisco Convention Center',
      organizerName: 'Tech Events International',
      description: 'Successfully participated in all sessions and workshops'
    })
  },

  // Marketing
  {
    templateId: 'mp-marketing-brochure',
    category: 'marketing',
    name: 'Product Brochure',
    description: 'Professional product brochure template with features, pricing, and call-to-action. Ideal for product launches and sales materials.',
    tags: ['brochure', 'product', 'marketing', 'sales'],
    popularity: 0,
    sampleDataJson: JSON.stringify({
      productName: 'CloudSync Pro',
      tagline: 'Sync Everything, Everywhere',
      heroDescription: 'The ultimate cloud synchronization solution for modern teams.',
      features: [
        { title: 'Real-time Sync', description: 'Instant synchronization across all your devices' },
        { title: 'End-to-end Encryption', description: 'Military-grade security for your data' },
        { title: '24/7 Support', description: 'Expert help whenever you need it' },
        { title: 'Unlimited Storage', description: 'Store as much as you need' }
      ],
      pricing: {
        starter: { price: 9.99, features: ['5 users', '100GB storage', 'Email support'] },
        professional: { price: 29.99, features: ['25 users', '1TB storage', 'Priority support'] },
        enterprise: { price: 99.99, features: ['Unlimited users', 'Unlimited storage', '24/7 support'] }
      },
      ctaText: 'Start Your Free Trial',
      ctaUrl: 'https://example.com/trial'
    })
  },
  {
    templateId: 'mp-marketing-flyer',
    category: 'marketing',
    name: 'Event Flyer',
    description: 'Eye-catching flyer for events and promotions. Features bold design elements and clear call-to-action.',
    tags: ['flyer', 'event', 'promotion', 'marketing'],
    popularity: 0,
    sampleDataJson: JSON.stringify({
      eventTitle: 'Summer Music Festival 2025',
      eventSubtitle: 'Three Days of Non-Stop Music',
      date: 'July 15-17, 2025',
      time: '12:00 PM - 11:00 PM',
      venue: 'Central Park Amphitheater',
      address: '123 Park Avenue, New York, NY',
      highlights: [
        '20+ Live Performances',
        'Food & Craft Vendors',
        'Family-Friendly Activities',
        'VIP Experience Available'
      ],
      ticketPrice: 'Starting at $49',
      ctaText: 'Get Tickets Now',
      website: 'www.summerfest2025.com'
    })
  },
  {
    templateId: 'mp-marketing-newsletter',
    category: 'marketing',
    name: 'Email Newsletter',
    description: 'Professional newsletter template with sections for articles, updates, and CTAs. Perfect for regular customer communications.',
    tags: ['newsletter', 'email', 'marketing', 'communication'],
    popularity: 0,
    sampleDataJson: JSON.stringify({
      companyName: 'TechNews Weekly',
      issueNumber: 42,
      issueDate: 'January 15, 2025',
      headerImage: '',
      greeting: 'Hello Tech Enthusiasts!',
      introText: 'Welcome to this week\'s edition of TechNews Weekly. We\'ve got exciting updates and insights to share with you.',
      articles: [
        {
          title: 'AI Revolution in 2025',
          summary: 'Discover how artificial intelligence is transforming industries and what it means for your business.',
          readMoreUrl: '#'
        },
        {
          title: 'Top 10 Developer Tools',
          summary: 'Our curated list of must-have tools that will boost your productivity this year.',
          readMoreUrl: '#'
        }
      ],
      ctaTitle: 'Upgrade Your Subscription',
      ctaText: 'Get premium access to exclusive content and features.',
      ctaButton: 'Upgrade Now',
      socialLinks: {
        twitter: 'https://twitter.com',
        linkedin: 'https://linkedin.com',
        facebook: 'https://facebook.com'
      }
    })
  },

  // Personal
  {
    templateId: 'mp-personal-resume',
    category: 'personal',
    name: 'Modern Resume',
    description: 'Clean, modern resume template with sections for experience, skills, and education. ATS-friendly design.',
    tags: ['resume', 'cv', 'job', 'career', 'professional'],
    popularity: 0,
    sampleDataJson: JSON.stringify({
      name: 'Alexandra Johnson',
      title: 'Senior Software Engineer',
      email: 'alex.johnson@email.com',
      phone: '(555) 123-4567',
      location: 'San Francisco, CA',
      linkedin: 'linkedin.com/in/alexjohnson',
      summary: 'Experienced software engineer with 8+ years of expertise in full-stack development, cloud architecture, and team leadership.',
      experience: [
        {
          company: 'Tech Giants Inc',
          role: 'Senior Software Engineer',
          period: '2020 - Present',
          achievements: [
            'Led development of microservices architecture serving 10M+ users',
            'Mentored team of 5 junior developers',
            'Reduced deployment time by 60% through CI/CD improvements'
          ]
        },
        {
          company: 'StartupHub',
          role: 'Software Engineer',
          period: '2017 - 2020',
          achievements: [
            'Built core payment processing system handling $50M+ annually',
            'Implemented real-time notification system'
          ]
        }
      ],
      skills: ['JavaScript', 'TypeScript', 'React', 'Node.js', 'AWS', 'Python', 'PostgreSQL', 'Docker'],
      education: {
        degree: 'B.S. Computer Science',
        school: 'Stanford University',
        year: '2017'
      }
    })
  },
  {
    templateId: 'mp-personal-letter',
    category: 'personal',
    name: 'Formal Letter',
    description: 'Professional letter template for business correspondence. Includes proper formatting and structure.',
    tags: ['letter', 'formal', 'correspondence', 'business'],
    popularity: 0,
    sampleDataJson: JSON.stringify({
      senderName: 'John Smith',
      senderAddress: '123 Main Street',
      senderCity: 'New York, NY 10001',
      senderEmail: 'john.smith@email.com',
      senderPhone: '(555) 123-4567',
      date: 'January 15, 2025',
      recipientName: 'Ms. Sarah Williams',
      recipientTitle: 'Hiring Manager',
      recipientCompany: 'Innovation Corp',
      recipientAddress: '456 Business Ave',
      recipientCity: 'San Francisco, CA 94102',
      subject: 'Application for Senior Developer Position',
      salutation: 'Dear Ms. Williams',
      body: [
        'I am writing to express my strong interest in the Senior Developer position at Innovation Corp, as advertised on your company website.',
        'With over five years of experience in software development and a proven track record of delivering high-quality solutions, I am confident in my ability to contribute effectively to your team.',
        'I would welcome the opportunity to discuss how my skills and experience align with your needs. Thank you for considering my application.'
      ],
      closing: 'Sincerely',
      signature: 'John Smith'
    })
  },
  {
    templateId: 'mp-personal-invitation',
    category: 'personal',
    name: 'Event Invitation',
    description: 'Elegant invitation template for parties and events. Customizable design for any occasion.',
    tags: ['invitation', 'party', 'event', 'celebration'],
    popularity: 0,
    sampleDataJson: JSON.stringify({
      eventType: 'Birthday Celebration',
      hostName: 'The Johnson Family',
      honoree: 'Emma',
      eventTitle: 'Emma\'s 10th Birthday Party!',
      date: 'Saturday, February 15, 2025',
      time: '2:00 PM - 5:00 PM',
      venue: 'Sunshine Park Community Center',
      address: '789 Park Lane, Austin, TX',
      theme: 'Magical Unicorn Adventure',
      dressCode: 'Casual / Colorful',
      rsvpBy: 'February 8, 2025',
      rsvpContact: 'jennifer@email.com',
      rsvpPhone: '(555) 987-6543',
      specialInstructions: 'Please let us know of any food allergies.'
    })
  },
  {
    templateId: 'mp-personal-cover-letter',
    category: 'personal',
    name: 'Cover Letter',
    description: 'Professional cover letter template for job applications. Modern design with sections for key achievements and why you\'re the perfect fit.',
    tags: ['cover letter', 'job application', 'career', 'professional', 'hiring'],
    popularity: 0,
    sampleDataJson: JSON.stringify({
      applicantName: 'Alexandra Johnson',
      applicantEmail: 'alex.johnson@email.com',
      applicantPhone: '(555) 123-4567',
      applicantLocation: 'San Francisco, CA',
      applicantLinkedIn: 'linkedin.com/in/alexjohnson',
      applicantTitle: 'Senior Software Engineer',
      date: 'January 15, 2025',
      hiringManagerName: 'Ms. Sarah Chen',
      hiringManagerTitle: 'Engineering Director',
      companyName: 'TechVision Inc.',
      companyAddress: '456 Innovation Drive, San Francisco, CA 94102',
      positionTitle: 'Staff Software Engineer',
      openingParagraph: 'I am writing to express my enthusiastic interest in the Staff Software Engineer position at TechVision Inc. With over 8 years of experience building scalable systems and leading high-performing engineering teams, I am excited about the opportunity to contribute to your mission of revolutionizing enterprise software.',
      highlightText: 'I thrive at the intersection of technical excellence and team leadership, consistently delivering projects that exceed expectations while mentoring the next generation of engineers.',
      experienceParagraph: 'In my current role at Tech Giants Inc., I have led the development of a microservices architecture that serves over 10 million users daily. I spearheaded the migration from a monolithic system, reducing deployment time by 60% and improving system reliability to 99.99% uptime.',
      keyAchievements: [
        'Architected and deployed a real-time data pipeline processing 1M+ events per second',
        'Mentored 5 junior developers, with 3 receiving promotions within 18 months',
        'Reduced infrastructure costs by 40% through optimization and cloud-native redesign',
        'Led cross-functional team of 12 engineers delivering critical product launch on schedule'
      ],
      whyCompanyParagraph: 'I am particularly drawn to TechVision\'s commitment to innovation and your recent work on AI-powered enterprise solutions. Your engineering blog posts on distributed systems have been invaluable to my own learning, and I would be honored to contribute to such a forward-thinking team.',
      closingParagraph: 'I would welcome the opportunity to discuss how my technical expertise and leadership experience align with TechVision\'s goals. Thank you for considering my application. I look forward to speaking with you soon.'
    })
  }
];

async function clearExistingData() {
  console.log('Clearing existing marketplace data...');

  // Clear DynamoDB table
  const scanResult = await docClient.send(new ScanCommand({
    TableName: MARKETPLACE_TABLE,
    ProjectionExpression: 'templateId'
  }));

  if (scanResult.Items && scanResult.Items.length > 0) {
    for (const item of scanResult.Items) {
      await docClient.send(new DeleteCommand({
        TableName: MARKETPLACE_TABLE,
        Key: { templateId: item.templateId }
      }));
    }
    console.log(`  Deleted ${scanResult.Items.length} items from DynamoDB`);
  }

  // Clear S3 objects
  const listResult = await s3Client.send(new ListObjectsV2Command({
    Bucket: ASSETS_BUCKET,
    Prefix: 'marketplace/templates/'
  }));

  if (listResult.Contents && listResult.Contents.length > 0) {
    for (const obj of listResult.Contents) {
      if (obj.Key) {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: ASSETS_BUCKET,
          Key: obj.Key
        }));
      }
    }
    console.log(`  Deleted ${listResult.Contents.length} objects from S3`);
  }
}

async function seedTemplates() {
  console.log(`\nSeeding marketplace templates to ${stage} environment...`);
  const now = new Date().toISOString();

  for (const template of templates) {
    const s3Key = `marketplace/templates/${template.templateId}.hbs`;
    const thumbnailKey = `marketplace/thumbnails/${template.templateId}.png`;
    const templateFilePath = path.join(TEMPLATES_DIR, `${template.templateId}.hbs`);

    // Check if template file exists
    if (!fs.existsSync(templateFilePath)) {
      console.log(`  ⚠️  Template file not found: ${templateFilePath}`);
      continue;
    }

    // Read template content
    const content = fs.readFileSync(templateFilePath, 'utf-8');

    // Upload to S3
    await s3Client.send(new PutObjectCommand({
      Bucket: ASSETS_BUCKET,
      Key: s3Key,
      Body: content,
      ContentType: 'text/x-handlebars-template',
      Metadata: {
        templateId: template.templateId,
        category: template.category
      }
    }));

    // Save to DynamoDB
    const item: MarketplaceTemplate = {
      ...template,
      s3Key,
      thumbnailKey,
      createdAt: now,
      updatedAt: now
    };

    await docClient.send(new PutCommand({
      TableName: MARKETPLACE_TABLE,
      Item: item
    }));

    console.log(`  ✓ ${template.name} (${template.category})`);
  }

  console.log(`\n✅ Successfully seeded ${templates.length} marketplace templates!`);
}

async function main() {
  try {
    console.log('='.repeat(50));
    console.log(`Marketplace Template Seeder - ${stage.toUpperCase()}`);
    console.log('='.repeat(50));
    console.log(`Table: ${MARKETPLACE_TABLE}`);
    console.log(`Bucket: ${ASSETS_BUCKET}`);
    console.log(`Templates: ${TEMPLATES_DIR}`);
    console.log('='.repeat(50));

    await clearExistingData();
    await seedTemplates();
  } catch (error) {
    console.error('Error seeding marketplace:', error);
    process.exit(1);
  }
}

// Guard: only run the destructive clear+seed when invoked directly,
// so other scripts (e.g. generate-thumbnails.ts) can safely import `templates`.
if (require.main === module) {
  main();
}
