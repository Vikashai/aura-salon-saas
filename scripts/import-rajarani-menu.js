'use strict';
require('dotenv').config();
const mysql=require('mysql2/promise');

const groups={
  'Women · Hair Cuts':[['Baby Haircut',300],['Baby Haircut + Shampoo',500],['Classic Haircut (Straight / U-Cut)',500],['Premium Layer Haircut',700],['Split End Trimming',700],['Customized Haircut',1000]],
  'Women · Hair Wash':[['Shampoo Wash',300],['Conditioner Wash',300],['Shampoo + Conditioner',500],['Korean Mashup Hair & Face Wash Ritual',600]],
  'Women · Hair Styling':[['Straight Blow Dry',500],['Curly Blow Dry',700],['Temporary Straightening',700],['Deep Curl Styling (Tongs)',700],['Premium Hair Styling',1000],['Blast Blow Dry',300]],
  'Women · Hair Spa':[['Hair Spa',1200],['Premium Hair Spa',1500],['Hair Spa for Dry & Damaged Hair',1300],['Hair Spa + Dandruff Therapy',1800],['Hair Spa + Hair Fall Therapy',1800],['Lice Treatment',1500]],
  'Women · Head Massage':[['Head Massage',300],['Olive Oil Almond Massage',400],['Aroma Oils & Flavors Massage',500]],
  'Women · Hair Colour':[['Root Touch-Up',1000],['Ammonia-Free Root Touch-Up',1200],['Premium Global Colour',2500],['Fashion Global Colour',2500],['Highlight (Single Streak)',500],['Premium Full Highlights',3000]],
  'Women · Hair Transformation':[['Smoothening',4000],['Straightening',4000],['Keratin Treatment',4000],['Botox Hair Treatment',5000],['Nano Hair Treatment',6000],['Re-Growth / Partial Straightening',4500],['Hair Extensions',0]],
  'Women · Clean-Up':[['Express Clean-Up Basic',700],['Women’s Clean-Up',800],['Fruit Glow Clean-Up',1100],['Korean Clean-Up',999],['Korean Express Clean-Up + Hair Wash',1000],['Raja Rani Signature Clean-Up + Hair Wash',1200],['Express Glow Clean-Up',1299]],
  'Women · Facial Add-Ons':[['Raja Rani Special Original Fruit Mask',500],['Brightening Mask Therapy',600],['Skin Tightening Collagen Mask',400],['O3 Oxygen Rejuvenating Mask',500]],
  'Women · De-Tan':[['Upper Lip De-Tan',99],['Underarm De-Tan',199],['Feet De-Tan',299],['Face & Neck De-Tan',499],['Blouse Line De-Tan',299],['Half Arms De-Tan',499],['Full Arms De-Tan',599],['Half Legs De-Tan',799],['Full Legs De-Tan',999],['Half Back / Front De-Tan',799],['Full Back / Front De-Tan',999],['Full Body De-Tan',2499]],
  'Women · Facials':[['Premium Gold Facial',1599],['Premium Diamond Facial',1699],['Moisture Lock Facial',1499],['Oxy Glow Facial',1999],['Skin Tightening Facial',1599],['Hydra Facial',4999],['Collagen Peptide Facial',1700],['Glutathione Brightening Facial',2000],['Hyaluronic Hydration Facial',2200],['Korean Premium Glass Skin Facial',2500]],
  'Women · Waxing':[['Full Arms Waxing',599],['Half Arms Waxing',499],['Full Legs Waxing',1199],['Half Legs Waxing',599],['Underarm Waxing',199],['Full Face Waxing',699],['Bikini Waxing',1999],['Jawline / Upper Lip / Chin Waxing',299],['Full Body Waxing',2999]],
  'Women · Threading':[['Eyebrows',50],['Upper Lip',50],['Forehead',50],['Chin',50],['Full Face Threading',199]],
  'Women · Manicure':[['Classic Manicure',500],['Crystal Glow Manicure',800],['Deep Cleansing Manicure',800],['Dead Sea Charcoal Manicure',900],['Organic Spa Manicure',1000],['Korean Luxury Spa Manicure',1200],['French Special Manicure',900]],
  'Women · Pedicure':[['Classic Pedicure',700],['Crystal Glow Pedicure',1000],['Deep Cleansing Pedicure',1300],['Dead Sea Charcoal Detox Pedicure',1500],['Organic Spa Pedicure',1200],['Korean Luxury Spa Pedicure',1400],['French Special Pedicure',1800]],
  'Women · Mani-Pedi Rituals':[['Korean Snail Therapy Mani-Pedi',2200],['Luxury Spa Manicure & Pedicure',2000],['Footlogix Advanced Pedicure',2500]],
  'Women · Nail & Polish':[['Nail Paint Change',130],['Cut, File & Shape',200],['Gel Polish Application',600],['Gel Polish Removal',300]],
  'Women · Piercing & Skin Care':[['Ear Piercing',500],['Nose Piercing',500],['Warts Removal',100]],
  'Women · Bridal & Occasion':[['Bridal Package',15000],['Saree Box Folding',500]],
  'Women · Korean Luxury':[['Korean Hair Wash',300],['Korean Basic Pedicure',900],['Korean Body Vapour Bed Therapy',2000],['Korean Full Body Polish & Steam Bed Experience',3000],['Body Massage with Aroma Oils',2000]],
  'Men · Classic Grooming':[['Classic Haircut',200],['Beard Trim',120],['Beard Styling',200],['Shave',100],['Head Shave',150],['Kids Haircut',200],['Hair Wash',100]],
  'Men · Premium Grooming':[['Executive Shave',550],['Haircut + Executive Shave',650],['Korean Hair Wash + Haircut',300]],
  'Men · Hair Colour':[['Grey Coverage Colour (Ammonia)',700],['Grey Coverage Colour (Ammonia Free)',1200],['Global Fashion Colour',1400],['Highlights (Per Streak)',300],['Moustache Colour',150],['Beard Colour',250],['Beard + Moustache Colour',300]],
  'Men · Head & Scalp Massage':[['Head Massage with Hair Wash',300],['Olive & Almond Oil Massage',400],['Aromatic Oil Massage',500]],
  'Men · Hair Transformation':[['Smoothening',2999],['Straightening',2999],['Keratin Treatment',3999],['Hair Botox Treatment',4999],['Nano Hair Treatment',4999]],
  'Men · Scalp Therapy':[['Hair Spa',800],['Premium Hair Spa',1000],['Advanced Scalp Treatment',1400],['Dandruff Control Therapy',1400],['Hair Fall Control Therapy',1500],['Lice Treatment',1500]],
  'Men · Skin Basics':[['Men’s Clean-Up',800],['Express Facial',700],['Fruit Glow Clean-Up',1100],['Korean Clean-Up',700],['Korean Express Clean-Up + Hair Wash',1000],['Raja Rani Signature Clean-Up + Hair Wash',1200]],
  'Men · Luxury Facials':[['Brightening Bliss Facial',1700],['Luxury Gold Facial',1900],['Hydra Facial',4999],['Collagen Peptide Facial',2000],['Glutathione Brightening Facial',2000],['Hyaluronic Hydration Facial',2200],['Skin Tightening Facial',1599]],
  'Men · Facial Add-Ons':[['Face De-Tan',300],['Face & Neck De-Tan',500],['Skin Tightening Collagen Mask',400],['Brightening Mask Therapy',600],['Raja Rani Special Original Fruit Mask',500]],
  'Men · Body Care':[['Full Body Polish',2000],['Body Polish + Vapour Bath',2500],['Neck & Shoulder Reflexology',400],['Hands & Feet Reflexology',400],['Foot Reflexology',400],['Face Massage',200]],
  'Men · Manicure':[['Classic Manicure',500],['Crystal Glow Manicure',800],['Deep Cleansing Manicure',800],['Dead Sea Charcoal Manicure',900],['Organic Spa Manicure',1000],['Korean Luxury Spa Manicure',1200],['French Special Manicure',900]],
  'Men · Pedicure':[['Classic Pedicure',700],['Crystal Glow Pedicure',1000],['Deep Cleansing Pedicure',1300],['Dead Sea Charcoal Detox Pedicure',1500],['Organic Spa Pedicure',1200],['Korean Luxury Spa Pedicure',1400],['French Special Pedicure',1800],['Heel Peel Treatment',2000]],
  'Men · Groom Makeup':[['Groom Makeup',5000]],
  'Men · Korean Luxury':[['Korean Hair Wash',300],['Korean Basic Pedicure',900],['Korean Body Vapour Bed Therapy',2000],['Korean Full Body Polish & Steam Bed Experience',3000],['Body Massage with Aroma Oils',2000]],
};

async function main(){const connection=await mysql.createConnection({host:process.env.DB_HOST,port:Number(process.env.DB_PORT||3306),database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD,charset:'utf8mb4'});if(process.env.RESET_EXISTING_SERVICES==='YES')await connection.execute('UPDATE services SET archived=1');let inserted=0,updated=0;for(const[category,items]of Object.entries(groups))for(const[name,price]of items){const[rows]=await connection.execute('SELECT id FROM services WHERE category=? AND name=? LIMIT 1',[category,name]);if(rows[0]){await connection.execute("UPDATE services SET price=?,status='Active',archived=0 WHERE id=?",[price,rows[0].id]);updated++;}else{await connection.execute("INSERT INTO services(name,category,price,duration,commission,status,popular,archived) VALUES(?,?,?,60,0,'Active',0,0)",[name,category,price]);inserted++;}}await connection.end();console.log(`Raja Rani menu ready: ${inserted} added, ${updated} updated.`)}
main().catch(error=>{console.error(error);process.exitCode=1});
