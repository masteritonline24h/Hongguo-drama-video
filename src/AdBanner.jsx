import React, { useEffect, useRef } from 'react';

const AdBanner = () => {
  const adRef = useRef(null);

  useEffect(() => {
    // Set the global ad options
    window.atOptions = {
      'key': '4692dd0b42853ebbaace72d9a4822b95',
      'format': 'iframe',
      'height': 90,
      'width': 728,
      'params': {}
    };

    // Create script element
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = 'https://www.highrevenueformat.com/4692dd0b42853ebbaace72d9a4822b95/invoke.js';
    script.async = true;

    // Append script to container
    const container = adRef.current;
    if (container) {
      container.appendChild(script);
    }

    // Cleanup on unmount
    return () => {
      if (container) {
        container.innerHTML = '';
      }
    };
  }, []);

  return (
    <div 
      ref={adRef} 
      style={{ 
        width: '728px', 
        height: '90px', 
        margin: '0 auto', 
        display: 'flex', 
        justifyContent: 'Center', 
        alignItems: 'center' 
      }} 
    />
  );
};

export default AdBanner;